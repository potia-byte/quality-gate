import { defaultConfig, type QualityGateConfig } from "./config.js";

export type SizeGateVerdict = "PASS" | "MUST_DECOMPOSE";

/** Fields the Size Gate reads. Any task-like object with these fits. */
export interface SizeGateInput {
  description: string;
  allowed_paths: string[];
  acceptance_criteria: unknown[];
  depends_on: unknown[];
  estimated_duration_ms?: number | null;
}

/**
 * Top-level subsystem a path belongs to: the first path segment, plus a
 * second segment for configured two-level roots (`apps/*`, `packages/*`,
 * ...) so `apps/web` and `apps/server` count as distinct subsystems.
 */
export function subsystemOf(
  path: string,
  twoLevelRoots: readonly string[] = defaultConfig.size.twoLevelRoots,
): string {
  const segments = path.split("/").filter(Boolean);
  const [first, second] = segments;
  if (first === undefined) return path;
  if (second === undefined || !twoLevelRoots.includes(first)) return first;
  return `${first}/${second}`;
}

export interface SizeGateResult {
  verdict: SizeGateVerdict;
  reasons: string[];
  signals: {
    filesTouched: number;
    acceptanceCriteriaCount: number;
    subsystemCount: number;
    subsystems: string[];
    dependencyCount: number;
    estimatedDurationMs: number | null;
    descriptionLength: number;
  };
}

/**
 * Deterministic, zero-LLM decision on whether a proposed task is small
 * enough to execute as-is (`PASS`) or must first be decomposed
 * (`MUST_DECOMPOSE`). Pure function, no I/O. Any single breached threshold
 * trips `MUST_DECOMPOSE`; `reasons` names every signal that tripped.
 */
export function evaluateSizeGate(
  input: SizeGateInput,
  config: QualityGateConfig = defaultConfig,
): SizeGateResult {
  const limits = config.size;
  const reasons: string[] = [];

  const filesTouched = input.allowed_paths.length;
  if (filesTouched > limits.maxAllowedPaths) {
    reasons.push(
      `too many files touched: ${filesTouched} > ${limits.maxAllowedPaths}`,
    );
  }

  const acceptanceCriteriaCount = input.acceptance_criteria.length;
  if (acceptanceCriteriaCount > limits.maxAcceptanceCriteria) {
    reasons.push(
      `too many acceptance criteria: ${acceptanceCriteriaCount} > ${limits.maxAcceptanceCriteria}`,
    );
  }

  const subsystems = [
    ...new Set(
      input.allowed_paths.map((path) => subsystemOf(path, limits.twoLevelRoots)),
    ),
  ];
  const subsystemCount = subsystems.length;
  if (subsystemCount > limits.maxSubsystems) {
    reasons.push(
      `touches too many subsystems: ${subsystemCount} > ${limits.maxSubsystems} (${subsystems.join(", ")})`,
    );
  }

  const dependencyCount = input.depends_on.length;
  if (dependencyCount > limits.maxDependencies) {
    reasons.push(
      `too many dependencies: ${dependencyCount} > ${limits.maxDependencies}`,
    );
  }

  const estimatedDurationMs = input.estimated_duration_ms ?? null;
  const descriptionLength = input.description.length;
  if (estimatedDurationMs !== null) {
    if (estimatedDurationMs > limits.maxEstimatedDurationMs) {
      reasons.push(
        `estimated duration too long: ${estimatedDurationMs}ms > ${limits.maxEstimatedDurationMs}ms`,
      );
    }
  } else if (descriptionLength > limits.maxDescriptionLength) {
    reasons.push(
      `description too long (no estimated_duration_ms set, using length as proxy): ${descriptionLength} chars > ${limits.maxDescriptionLength} chars`,
    );
  }

  return {
    verdict: reasons.length > 0 ? "MUST_DECOMPOSE" : "PASS",
    reasons,
    signals: {
      filesTouched,
      acceptanceCriteriaCount,
      subsystemCount,
      subsystems,
      dependencyCount,
      estimatedDurationMs,
      descriptionLength,
    },
  };
}
