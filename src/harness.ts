import { spawn, spawnSync } from "node:child_process";
import { defaultConfig, type QualityGateConfig } from "./config.js";
import { pathMatches } from "./git.js";
import { classifyCommand } from "./security-policy.js";

export interface CheckResult {
  command: string;
  passed: boolean;
  /**
   * True when the check could not be run at all (spawn error, ENOENT/EINVAL,
   * broken cwd, an unexpected runner exception), as opposed to the command
   * running to completion and genuinely failing.
   */
  errored?: boolean;
  details: string;
  artifacts?: string[];
}

export type HarnessCheckRunner = (
  command: string,
  root: string,
) => Promise<CheckResult>;

export interface HarnessTaskShape {
  risk_level: "low" | "medium" | "high" | null;
  attempts: number;
  allowed_paths: string[];
  required_checks: string[];
}

export type HarnessMode = "smoke" | "full";

/** Picks how much verification a task needs. Escalation only ever goes up. */
export function selectHarnessMode(
  task: HarnessTaskShape,
  config: QualityGateConfig = defaultConfig,
): HarnessMode {
  if (task.risk_level === "medium" || task.risk_level === "high") return "full";
  if (task.attempts > 1) return "full";
  const riskyRules = config.harness.fullRiskPaths;
  if (
    task.allowed_paths.some((path) =>
      riskyRules.some(
        (rule) =>
          pathMatches(rule, path) ||
          pathMatches(path, rule.replace("/**", "/x")),
      ),
    )
  ) {
    return "full";
  }
  return "smoke";
}

/** Commands the independent harness runs for a task in the given mode. */
export function harnessCommands(
  task: HarnessTaskShape,
  mode: HarnessMode = selectHarnessMode(task),
  config: QualityGateConfig = defaultConfig,
): string[] {
  const full = [config.harness.fullCommand];
  if (mode === "full") return full;
  const known = new Set(config.harness.knownScripts);
  const required = task.required_checks.map((check) =>
    check.replace(/^npm run /, ""),
  );
  if (required.some((check) => !known.has(check))) return full;
  return [
    ...new Set([
      ...config.harness.smokeBaseCommands,
      ...required.map((check) => `npm run ${check}`),
    ]),
  ];
}

/**
 * Splits a command into argv for POSIX `execFile` (no shell involved there,
 * so file and args must be separated). Every command reaching this point has
 * already cleared `classifyCommand`'s allowlist, so a whitespace split is
 * enough; these are runner-constructed strings, not arbitrary input.
 */
export function parseHarnessCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Resolves how to spawn a policy-approved command.
 *
 * Windows installs npm/npx/git as `.cmd` shims; spawning one directly with
 * shell:false fails immediately with `spawn EINVAL`, so it must run through
 * `cmd.exe /d /s /c`. The whole trimmed command is passed as ONE argument and
 * Node's default (non-verbatim) quoting wraps it in a single pair of quotes.
 * Per-token caret-escaping would corrupt a shim's `%~dp0` self-location (it
 * would resolve to the cwd and npm would fail to find its own prefix), and is
 * unnecessary because the command already passed the allowlist.
 */
export function resolveHarnessInvocation(
  platform: NodeJS.Platform,
  command: string,
): { file: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", trimmed],
    };
  }
  const [file, ...args] = parseHarnessCommand(trimmed);
  if (!file) return null;
  return { file, args };
}

/**
 * Distinguishes a genuine check failure (the command ran and exited non-zero,
 * or was killed by a signal/timeout) from an infrastructure failure where the
 * check never ran (spawn EINVAL/ENOENT, a broken cwd, ...).
 *
 * Node's error shapes make this reliable: a process that launched and exited
 * non-zero has a NUMERIC `.code` with no `.syscall`; a process that never
 * launched has a STRING `.code` plus a `.syscall` starting with "spawn".
 */
export function isRunnerExecutionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  if (typeof err.syscall === "string" && err.syscall.startsWith("spawn"))
    return true;
  return typeof err.code === "string";
}

function killProcessTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill /T walks the whole tree. Killing only the cmd.exe wrapper
    // would leave npm and node alive, still holding the working directory.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid: the whole process group
  } catch {
    fallback();
  }
}

/**
 * Runs a command with a timeout that kills the entire process tree. Node's
 * own `timeout` option signals only the direct child, which on Windows is
 * the cmd.exe wrapper; the grandchildren (npm, node) survive and keep the
 * working directory locked, which later shows up as EPERM on cleanup.
 *
 * Error shapes match execFile's so `isRunnerExecutionError` keeps working:
 * a non-zero exit carries a numeric `code`; a launch failure carries a string
 * `code` and a `spawn` syscall; a timeout has `killed: true` and no string
 * code, i.e. it is a FAIL (the check did run), not an infrastructure error.
 */
function execWithTreeKill(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const keepTail = (current: string, chunk: Buffer): string =>
      (current + chunk.toString("utf8")).slice(-options.maxBuffer);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, () => child.kill("SIGKILL"));
    }, options.timeout);
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    child.on("error", (error) => {
      settle(() => reject(Object.assign(error, { stdout, stderr })));
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(
            Object.assign(
              new Error(`Command timed out after ${options.timeout}ms: ${args.join(" ")}`),
              { killed: true, signal, stdout, stderr },
            ),
          );
        } else if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            Object.assign(
              new Error(`Command failed: ${args.join(" ")} (exit ${code ?? signal})`),
              { code, signal, stdout, stderr },
            ),
          );
        }
      });
    });
  });
}

/**
 * Builds the production runner: policy check first, then a real subprocess.
 * `timeoutMs` bounds one command; on expiry the wrapper process is killed and
 * the check is reported as a FAIL (not an infrastructure error).
 */
export function createHarnessRunner(
  config: QualityGateConfig = defaultConfig,
  options: { timeoutMs?: number } = {},
): HarnessCheckRunner {
  const timeout = options.timeoutMs ?? config.harness.timeoutMs;
  return async (command, root) => {
    const policyDecision = classifyCommand(command, {
      root,
      trustLevel: "TRUSTED_TOOL",
      config,
    });
    if (policyDecision.decision !== "SAFE") {
      return {
        command,
        passed: false,
        details: `Security policy ${policyDecision.decision}: ${policyDecision.reason}`,
      };
    }
    const invocation = resolveHarnessInvocation(process.platform, command);
    if (!invocation) {
      return {
        command,
        passed: false,
        details: "Unsupported verification command.",
      };
    }
    try {
      const { stdout, stderr } = await execWithTreeKill(
        invocation.file,
        invocation.args,
        { cwd: root, maxBuffer: 20 * 1024 * 1024, timeout },
      );
      return {
        command,
        passed: true,
        details: `${stdout}\n${stderr}`.trim().slice(-8000),
      };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      return {
        command,
        passed: false,
        errored: isRunnerExecutionError(error),
        details:
          `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
            .trim()
            .slice(-8000),
      };
    }
  };
}

/** Production runner with the default configuration. */
export const runHarnessCheck: HarnessCheckRunner = createHarnessRunner();
