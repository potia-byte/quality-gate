import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityGate, type QualityGateOptions } from "../src/index.js";

/**
 * Timeout for tests that spawn real processes. Vitest's default is 5 s.
 * Measured on the development machine, `cmd.exe /c npm run <script>` costs
 * about 0.5 s when idle and several times that while other test files spawn
 * git and npm in parallel and antivirus scans each new process. Three npm
 * invocations in sequence can therefore exceed 5 s without anything being
 * wrong. 60 s is generous but still a real upper bound: a hung child fails
 * the test instead of stalling the run.
 */
export const SPAWN_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=Gate Test",
    "-c",
    "user.email=gate@example.test",
    "commit",
    "-qm",
    message,
  );
  return git(root, "rev-parse", "HEAD");
}

/**
 * Removes a temp directory. On Windows `rmSync` can fail with EPERM/EBUSY
 * while a child process still has the directory as its cwd or antivirus holds
 * a handle; `maxRetries`/`retryDelay` make Node retry with backoff.
 */
export function removeDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

export function cleanupRepositories(): void {
  for (const root of roots.splice(0)) removeDirectory(root);
}

export function tempDirectory(prefix = "qg-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A fresh git repository with one commit containing README.md and work.txt. */
export function repository(): string {
  const root = tempDirectory("qg-gate-test-");
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "base\n");
  writeFileSync(join(root, "work.txt"), "base\n");
  commitAll(root, "initial");
  return root;
}

export async function claimedGate(
  root: string,
  options: {
    deterministic?: boolean;
    config?: QualityGateOptions["config"];
    risk_level?: "low" | "medium" | "high";
  } = {},
): Promise<QualityGate> {
  const gate = new QualityGate({
    repoRoot: root,
    config: options.config ?? {},
  });
  await gate.addTask({
    id: "TASK-1",
    title: "Candidate",
    description: "Change work.txt",
    allowed_paths: ["work.txt"],
    forbidden_paths: ["secret/**"],
    acceptance_criteria: [
      options.deterministic
        ? {
            text: "Requested behavior works",
            verification_type: "deterministic",
            verification: "npm run test",
          }
        : "Requested behavior works",
    ],
    required_checks: ["test"],
    ...(options.risk_level ? { risk_level: options.risk_level } : {}),
  });
  await gate.claim("TASK-1", "codex");
  return gate;
}

export function commitCandidate(root: string, content = "implemented\n"): string {
  writeFileSync(join(root, "work.txt"), content);
  return commitAll(root, "TASK-1 candidate");
}

export async function submit(gate: QualityGate, candidate: string) {
  return gate.submitDeveloperResult("TASK-1", {
    status: "IMPLEMENTED",
    summary: "Implemented candidate.",
    changedFiles: ["work.txt"],
    candidateCommit: candidate,
    knownIssues: [],
  });
}

export const greenRunner = async (command: string) => ({
  command,
  passed: true,
  details: "green",
});
