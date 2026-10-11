import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Directory the file-backed ledger lives in; never counted as a task change. */
export const LEDGER_DIRECTORY = ".quality-gate";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function commitIsAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Files added/copied/modified/renamed/deleted between two commits. */
export function changedFilesBetween(
  root: string,
  baseCommit: string,
  candidateCommit: string,
): string[] {
  const output = git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=ACMRD",
    `${baseCommit}..${candidateCommit}`,
  ]);
  return output
    .split(/\r?\n/)
    .map((path) => path.replaceAll("\\", "/").trim())
    .filter(Boolean);
}

export function commitDiff(
  root: string,
  baseCommit: string,
  candidateCommit: string,
): string {
  return git(root, ["diff", "--no-ext-diff", baseCommit, candidateCommit]);
}

export function assertGitRepository(root: string): void {
  try {
    git(root, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`quality-gate requires a git repository: ${resolve(root)}`);
  }
}

export function currentHead(root: string): string | null {
  try {
    return git(root, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/** Working-tree changes (including untracked files), posix-normalized. */
export function changedFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const fields = output.split("\0").filter(Boolean);
  const result: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3).replaceAll("\\", "/");
    if (!path.startsWith(`${LEDGER_DIRECTORY}/`)) result.push(path);
    // In -z mode a rename/copy is followed by one extra field (the source).
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return [...new Set(result)].sort();
}

/**
 * Glob-ish path rule matching: "**", "dir/**", "dir/", "*" (one segment),
 * "**\/" (zero or more directories) and exact paths. Rules and candidates
 * are normalized to forward slashes.
 */
export function pathMatches(rule: string, candidate: string): boolean {
  const normalizedRule = rule.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedCandidate = candidate
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (normalizedRule === "**") return true;
  if (normalizedRule.endsWith("/**")) {
    const prefix = normalizedRule.slice(0, -3).replace(/\/$/, "");
    return (
      normalizedCandidate === prefix ||
      normalizedCandidate.startsWith(`${prefix}/`)
    );
  }
  if (normalizedRule.endsWith("/"))
    return normalizedCandidate.startsWith(normalizedRule);
  if (normalizedRule.includes("*")) {
    // A leading/embedded "**/" means "zero or more path segments", so it
    // becomes an *optional* group with its own slash; translating it to
    // ".*/" would wrongly require a "/" and fail to match top-level files.
    const escaped = normalizedRule
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**/", "__DOUBLE_STAR_SLASH__")
      .replaceAll("**", "__DOUBLE_STAR__")
      .replaceAll("*", "[^/]*")
      .replaceAll("__DOUBLE_STAR_SLASH__", "(?:.*/)?")
      .replaceAll("__DOUBLE_STAR__", ".*");
    return new RegExp(`^${escaped}$`).test(normalizedCandidate);
  }
  return normalizedCandidate === normalizedRule;
}

export interface ScopeRules {
  allowed_paths: string[];
  forbidden_paths: string[];
  allow_existing_changes?: boolean;
}

export interface GitSafetyResult {
  changed: string[];
  outsideAllowed: string[];
  forbidden: string[];
  existingAllowed: string[];
  safe: boolean;
  reason: string | null;
}

/** Is the working tree clean enough to start a task with this scope? */
export function inspectGitSafety(root: string, task: ScopeRules): GitSafetyResult {
  assertGitRepository(root);
  const changed = changedFiles(root);
  const forbidden = changed.filter((path) =>
    task.forbidden_paths.some((rule) => pathMatches(rule, path)),
  );
  const outsideAllowed = changed.filter(
    (path) => !task.allowed_paths.some((rule) => pathMatches(rule, path)),
  );
  const existingAllowed = changed.filter(
    (path) => !outsideAllowed.includes(path),
  );

  let reason: string | null = null;
  if (forbidden.length > 0) {
    reason = `Forbidden paths are dirty: ${forbidden.join(", ")}`;
  } else if (outsideAllowed.length > 0) {
    reason = `Changes outside allowed_paths: ${outsideAllowed.join(", ")}`;
  } else if (existingAllowed.length > 0 && !task.allow_existing_changes) {
    reason = `allowed_paths already contain changes, but allow_existing_changes is false: ${existingAllowed.join(", ")}`;
  }

  return {
    changed,
    outsideAllowed,
    forbidden,
    existingAllowed,
    safe: reason === null,
    reason,
  };
}

/**
 * Resolves a revision to a commit hash and requires the commit message to
 * mention the task id, which ties a commit to exactly one task.
 */
export function verifyCommit(
  root: string,
  revision: string,
  taskId: string,
): string {
  const hash = git(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const message = git(root, ["show", "-s", "--format=%B", hash]);
  if (!message.includes(taskId)) {
    throw new Error(
      `Commit ${hash.slice(0, 12)} message must contain task id ${taskId}.`,
    );
  }
  return hash;
}
