import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  defaultConfig,
  type QualityGateConfig,
  type QualityGateConfigInput,
  resolveConfig,
} from "./config.js";
import {
  assertGitRepository,
  changedFiles,
  changedFilesBetween,
  commitDiff,
  commitIsAncestor,
  currentHead,
  inspectGitSafety,
  pathMatches,
  verifyCommit,
} from "./git.js";
import {
  type CheckResult,
  createHarnessRunner,
  type HarnessCheckRunner,
  harnessCommands,
  selectHarnessMode,
} from "./harness.js";
import {
  boundedPromptSection,
  type BuiltPrompt,
  fitPromptSections,
  remainingRunContextBudget,
} from "./prompt-budget.js";
import {
  classifyReuseTier,
  type ReuseDecision,
  reuseDecisionOutcomeSchema,
} from "./reuse-gate.js";
import { classifyTaskRisk, type RiskLevel } from "./risk-policy.js";
import type {
  SecurityDecision,
  SecurityEventInput,
} from "./security-policy.js";
import { evaluateSizeGate } from "./size-gate.js";
import { FileStore, type GateStore, MemoryStore } from "./store.js";
import type {
  AcceptanceCriterion,
  DeveloperResult,
  GateEvent,
  GateEventType,
  GateRun,
  GateState,
  GateTask,
  HarnessReport,
  QaReview,
  VerificationType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Agent-facing envelopes (validated with zod)
// ---------------------------------------------------------------------------

const reuseDecisionInputSchema = z.object({
  requirement: z.string().min(1),
  checkedRepo: z.boolean(),
  checkedExistingDependencies: z.boolean(),
  checkedNativeCapability: z.boolean(),
  externalCandidate: z.string().min(1).nullable().optional(),
  decision: reuseDecisionOutcomeSchema,
  selectedSolution: z.string().min(1),
  reason: z.string().min(1),
});

export const developerResultInputSchema = z.object({
  status: z.enum(["IMPLEMENTED", "FAILED", "BLOCKED"]),
  summary: z.string().min(1),
  changedFiles: z.array(z.string()),
  candidateCommit: z.string().nullable(),
  knownIssues: z.array(z.string()),
  reuseDecision: reuseDecisionInputSchema.nullable().optional(),
});
export type DeveloperResultInput = z.infer<typeof developerResultInputSchema>;

/**
 * The same contract as `developerResultInputSchema`, derived from it so the
 * two cannot drift, as a JSON Schema. Hand it to an agent CLI that can
 * enforce a structured final answer instead of trusting prose instructions.
 */
export const developerResultJsonSchema: object = (() => {
  const schema = z.toJSONSchema(developerResultInputSchema) as Record<
    string,
    unknown
  >;
  const { $schema: _schema, ...rest } = schema;
  return rest;
})();

const qaDecisionInputSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("PASS"),
    reason: z.string().min(1),
    requiredChanges: z.array(z.string()).default([]),
    verification: z.array(z.string()).default([]),
  }),
  z.object({
    decision: z.literal("RETRY"),
    reason: z.string().min(1),
    requiredChanges: z.array(z.string()).min(1),
    verification: z.array(z.string()).min(1),
  }),
  z.object({
    decision: z.literal("BLOCK"),
    reason: z.string().min(1),
    requiredChanges: z.array(z.string()).default([]),
    verification: z.array(z.string()).default([]),
  }),
  z.object({
    decision: z.literal("ROLLBACK"),
    reason: z.string().min(1),
    severity: z.string().min(1),
    requiredChanges: z.array(z.string()).default([]),
    verification: z.array(z.string()).default([]),
  }),
]);
export type QaDecisionInput = z.input<typeof qaDecisionInputSchema>;

/** Parses an agent's JSON answer, tolerating a surrounding ```json fence. */
export function parseJsonResult(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
}

function taskAndRun(
  state: GateState,
  taskId: string,
): { task: GateTask; run: GateRun } {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const run = state.runs.find((item) => item.id === task.active_run_id);
  if (!run) throw new Error(`Task ${taskId} has no active run.`);
  return { task, run };
}

function taskById(state: GateState, taskId: string): GateTask {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function makeEvent(
  type: GateEventType,
  fields: Partial<Omit<GateEvent, "id" | "type" | "created_at">> = {},
): GateEvent {
  return {
    id: id("event"),
    type,
    run_id: null,
    task_id: null,
    candidate_commit: null,
    details: null,
    agent: null,
    requested_action: null,
    source: null,
    trust_level: null,
    decision: null,
    reason: null,
    created_at: timestamp(),
    ...fields,
  };
}

function createBlocker(
  state: GateState,
  task: GateTask,
  reason: string,
  requiredHumanAction: string,
): void {
  const createdAt = timestamp();
  const run = task.active_run_id
    ? state.runs.find((item) => item.id === task.active_run_id)
    : undefined;
  if (run) {
    run.status = "blocked";
    run.updated_at = createdAt;
    run.completed_at = createdAt;
    run.result = reason;
  }
  task.status = "blocked";
  task.last_error = reason;
  task.updated_at = createdAt;
  state.blockers.push({
    id: id("blocker"),
    task_id: task.id,
    run_id: run?.id ?? null,
    reason,
    required_human_action: requiredHumanAction,
    status: "open",
    created_at: createdAt,
    resolved_at: null,
  });
}

/**
 * Turns a non-PASS QA decision into the note the next developer attempt
 * receives. Carrying the structured lists forward is free (no model call)
 * and avoids a retry whose only cost is re-deriving what to fix.
 */
function formatQaFollowUpNote(review: {
  reason: string;
  required_changes: string[];
  verification: string[];
}): string {
  const parts = [review.reason];
  if (review.required_changes.length > 0) {
    parts.push(
      `Required changes:\n${review.required_changes.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (review.verification.length > 0) {
    parts.push(
      `Verification:\n${review.verification.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// QA prompt envelope (pure)
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for an independent QA reviewer. Only failed/errored
 * check evidence is included: a passing check's name is already in the
 * summary, and its output would push the failure evidence past the section's
 * truncation boundary.
 */
export function buildQaPromptEnvelope(
  task: GateTask,
  baseCommit: string,
  candidateCommit: string,
  report: HarnessReport,
  diff: string,
  priorReviews: QaReview[],
  budgetChars: number = task.context_budget_chars ??
    defaultConfig.qa.taskContextBudgetChars,
): BuiltPrompt {
  const criteria = task.acceptance_criteria
    .map(
      (criterion, index) =>
        `${index + 1}. ${criterion.text} [${criterion.verification_type}]`,
    )
    .join("\n");
  const reportSummary = {
    id: report.id,
    status: report.status,
    mode: report.mode,
    base_commit: report.base_commit,
    candidate_commit: report.candidate_commit,
    checks_run: report.checks_run,
    checks_passed: report.checks_passed,
    checks_failed: report.checks_failed,
  };
  const recentReviews = priorReviews.slice(-3).map((review) => ({
    decision: review.decision,
    reason: review.reason,
    required_changes: review.required_changes,
    verification: review.verification,
  }));
  const qaRelevantEvidence = report.check_evidence.filter(
    (item) => item.status !== "pass",
  );
  const budget = Math.max(0, budgetChars);
  const instructions = `You are an independent QA reviewer. You did not implement this work. This is a fresh agent process with no developer or prior-task conversation. Return JSON only.

Review semantic correctness, edge cases, scope, security, and llm_review_required criteria. Decision schema: {"decision":"PASS|RETRY|BLOCK|ROLLBACK","reason":"...","requiredChanges":["..."],"verification":["..."],"severity":"... only for ROLLBACK"}. Never PASS a failed harness or manual_required criterion.`;
  const taskSummary = `Task: ${task.id} -- ${task.title}
Allowed paths: ${task.allowed_paths.join(", ")}
Forbidden paths: ${task.forbidden_paths.join(", ") || "(none)"}
Required checks: ${task.required_checks.join(", ") || "(none)"}
Acceptance criteria:
${criteria}
Base commit: ${baseCommit}
Candidate commit: ${candidateCommit}`;

  return fitPromptSections(
    [
      { name: "qa_instructions", text: instructions },
      { name: "task_constraints", text: taskSummary },
      {
        ...boundedPromptSection(
          "task_description",
          `Task description:\n${task.description}`,
          Math.floor(budget * 0.15),
        ),
        optional: true,
      },
      {
        name: "harness_summary",
        text: `Harness summary:\n${JSON.stringify(reportSummary)}`,
      },
      {
        ...boundedPromptSection(
          "harness_evidence",
          `Harness evidence (failed/errored checks only -- see harness_summary for the full pass/fail list):\n${JSON.stringify(qaRelevantEvidence)}`,
          Math.floor(budget * 0.2),
        ),
        optional: true,
      },
      {
        ...boundedPromptSection(
          "prior_qa_reviews",
          `Latest prior QA reviews (at most 3):\n${JSON.stringify(recentReviews)}`,
          Math.floor(budget * 0.1),
        ),
        optional: true,
      },
      boundedPromptSection(
        "candidate_diff",
        `Candidate diff:\n${diff}`,
        Math.floor(budget * 0.35),
      ),
    ],
    budget,
  );
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface NewTaskInput {
  id: string;
  title: string;
  description: string;
  allowed_paths: string[];
  forbidden_paths?: string[];
  acceptance_criteria: Array<
    | string
    | {
        text: string;
        verification_type?: VerificationType;
        verification?: string | null;
      }
  >;
  required_checks?: string[];
  depends_on?: string[];
  rationale?: string | null;
  allow_existing_changes?: boolean;
  estimated_duration_ms?: number | null;
  /** When omitted it is computed by the risk policy. */
  risk_level?: RiskLevel;
  context_budget_chars?: number;
}

export interface QualityGateOptions {
  /** Git working tree the candidate commits live in. */
  repoRoot: string;
  /** Ledger. Defaults to an in-memory store. */
  store?: GateStore;
  config?: QualityGateConfig | QualityGateConfigInput;
  /** Check runner. Defaults to the production subprocess runner. */
  runner?: HarnessCheckRunner;
}

export interface QualityGateEvaluation {
  passed: boolean;
  failures: string[];
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class QualityGate {
  readonly repoRoot: string;
  readonly config: QualityGateConfig;
  readonly store: GateStore;
  private readonly runner: HarnessCheckRunner;

  constructor(options: QualityGateOptions) {
    this.repoRoot = options.repoRoot;
    this.config = resolveConfig(
      (options.config ?? {}) as QualityGateConfigInput,
    );
    this.store = options.store ?? new MemoryStore();
    this.runner = options.runner ?? createHarnessRunner(this.config);
  }

  /** Convenience: gate persisted at `<repoRoot>/.quality-gate/state.json`. */
  static withFileStore(
    options: Omit<QualityGateOptions, "store">,
  ): QualityGate {
    return new QualityGate({
      ...options,
      store: FileStore.forRepository(options.repoRoot),
    });
  }

  state(): Promise<GateState> {
    return this.store.read();
  }

  // -- task lifecycle -------------------------------------------------------

  /** Registers a task as "ready" and classifies its risk. */
  async addTask(input: NewTaskInput): Promise<GateTask> {
    if (!TASK_ID.test(input.id)) {
      throw new Error(`Invalid task id: ${input.id}`);
    }
    if (input.allowed_paths.length === 0) {
      throw new Error("A task needs at least one allowed path.");
    }
    if (input.acceptance_criteria.length === 0) {
      throw new Error("A task needs at least one acceptance criterion.");
    }
    const criteria: AcceptanceCriterion[] = input.acceptance_criteria.map(
      (criterion) =>
        typeof criterion === "string"
          ? {
              text: criterion,
              met: false,
              verification_type: "llm_review_required",
              verification: null,
            }
          : {
              text: criterion.text,
              met: false,
              verification_type:
                criterion.verification_type ?? "llm_review_required",
              verification: criterion.verification ?? null,
            },
    );
    const requiredChecks = input.required_checks ?? [];
    const forbidden = input.forbidden_paths ?? [];
    const risk = classifyTaskRisk(
      {
        title: input.title,
        description: input.description,
        rationale: input.rationale ?? null,
        allowed_paths: input.allowed_paths,
        forbidden_paths: forbidden,
        acceptance_criteria: criteria,
        required_checks: requiredChecks,
      },
      this.config,
    );
    const createdAt = timestamp();
    const task: GateTask = {
      id: input.id,
      title: input.title,
      description: input.description,
      status: "ready",
      depends_on: input.depends_on ?? [],
      allowed_paths: input.allowed_paths,
      forbidden_paths: forbidden,
      acceptance_criteria: criteria,
      required_checks: requiredChecks,
      allow_existing_changes: input.allow_existing_changes ?? false,
      estimated_duration_ms: input.estimated_duration_ms ?? null,
      rationale: input.rationale ?? null,
      risk_level: input.risk_level ?? risk.level,
      risk_reasons: risk.reasons,
      attempts: 0,
      last_error: null,
      commit: null,
      candidate_commit: null,
      harness_status: "not_run",
      qa_status: "not_run",
      last_failed_check: null,
      active_run_id: null,
      context_budget_chars: input.context_budget_chars,
      created_at: createdAt,
      updated_at: createdAt,
    };
    return this.store.update((state) => {
      if (state.tasks.some((item) => item.id === task.id)) {
        throw new Error(`Task already exists: ${task.id}`);
      }
      state.tasks.push(task);
      return task;
    });
  }

  /**
   * Starts a run. Refuses (and blocks the task) when the Size Gate says the
   * task must be decomposed, or when the working tree is not clean enough.
   */
  async claim(taskId: string, agent: string): Promise<GateRun> {
    assertGitRepository(this.repoRoot);
    const outcome = await this.store.update(
      (
        state,
      ): { run: GateRun | null; blocked: string | null; kind: "size" | "git" | null } => {
        const task = taskById(state, taskId);
        if (task.status !== "ready") {
          throw new Error(`Task ${taskId} is ${task.status}, not ready.`);
        }
        const size = evaluateSizeGate(task, this.config);
        if (size.verdict === "MUST_DECOMPOSE") {
          const reason = `Size Gate MUST_DECOMPOSE: ${size.reasons.join("; ")}`;
          state.events.push(
            makeEvent("SIZE_GATE_FLAGGED", {
              task_id: task.id,
              details: reason,
              agent,
              source: "size-gate",
              reason,
            }),
          );
          createBlocker(
            state,
            task,
            reason,
            "Split this task into smaller tasks, then release it.",
          );
          return { run: null, blocked: reason, kind: "size" };
        }
        const safety = inspectGitSafety(this.repoRoot, task);
        if (!safety.safe) {
          createBlocker(
            state,
            task,
            safety.reason ?? "Unsafe git state.",
            "Resolve or commit the conflicting working-tree changes, then release the task.",
          );
          return {
            run: null,
            blocked: safety.reason ?? "Unsafe git state.",
            kind: "git",
          };
        }
        const startedAt = timestamp();
        task.context_budget_chars ??= this.config.qa.taskContextBudgetChars;
        const run: GateRun = {
          id: id("run"),
          task_id: task.id,
          agent,
          status: "running",
          started_at: startedAt,
          updated_at: startedAt,
          completed_at: null,
          baseline_head: currentHead(this.repoRoot),
          baseline_dirty_files: safety.changed,
          result: null,
          developer_result_id: null,
          harness_report_ids: [],
          qa_review_ids: [],
          context_budget_chars: this.config.qa.runContextBudgetChars,
          context_usage: [],
        };
        task.status = "in_progress";
        task.attempts += 1;
        task.last_error = null;
        task.commit = null;
        task.candidate_commit = null;
        task.harness_status = "not_run";
        task.qa_status = "not_run";
        task.last_failed_check = null;
        for (const criterion of task.acceptance_criteria) criterion.met = false;
        task.active_run_id = run.id;
        task.updated_at = startedAt;
        state.runs.push(run);
        return { run, blocked: null, kind: null };
      },
    );
    if (!outcome.run) {
      if (outcome.kind === "size") {
        throw new Error(
          `Task ${taskId} requires decomposition: ${outcome.blocked}`,
        );
      }
      throw new Error(`Task ${taskId} blocked by git safety: ${outcome.blocked}`);
    }
    return outcome.run;
  }

  /**
   * Validates a developer's claim against the repository itself: the commit
   * must exist, mention the task id, be the checked-out HEAD, descend from the
   * run's baseline, and its real diff must equal the declared file list and
   * stay inside the allowed scope. Nothing the agent says is taken on trust.
   */
  async submitDeveloperResult(
    taskId: string,
    raw: unknown,
  ): Promise<DeveloperResult> {
    const input = developerResultInputSchema.parse(raw);
    const before = await this.store.read();
    const { task, run } = taskAndRun(before, taskId);
    if (task.status !== "in_progress" && task.status !== "validating") {
      throw new Error(
        `Task ${taskId} cannot submit a result while ${task.status}.`,
      );
    }

    let candidate: string | null = null;
    let actualFiles: string[] = [];
    const root = this.repoRoot;
    if (input.status === "IMPLEMENTED") {
      if (!input.candidateCommit) {
        throw new Error("IMPLEMENTED requires candidateCommit.");
      }
      if (!run.baseline_head) throw new Error("Run has no base commit.");
      candidate = verifyCommit(root, input.candidateCommit, taskId);
      if (candidate === run.baseline_head) {
        throw new Error("candidateCommit must differ from baseCommit.");
      }
      if (currentHead(root) !== candidate) {
        throw new Error(
          "candidateCommit must be the current checked-out HEAD.",
        );
      }
      if (!commitIsAncestor(root, run.baseline_head, candidate)) {
        throw new Error("candidateCommit is not descended from baseCommit.");
      }
      actualFiles = normalizeFiles(
        changedFilesBetween(root, run.baseline_head, candidate),
      );
      if (actualFiles.length === 0) {
        throw new Error("candidateCommit must contain a task diff.");
      }
      const declaredFiles = normalizeFiles(input.changedFiles);
      if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
        throw new Error(
          `changedFiles do not match the commit diff (actual: ${actualFiles.join(", ") || "none"}).`,
        );
      }
      const outside = actualFiles.filter(
        (file) => !task.allowed_paths.some((rule) => pathMatches(rule, file)),
      );
      const forbidden = actualFiles.filter((file) =>
        task.forbidden_paths.some((rule) => pathMatches(rule, file)),
      );
      if (outside.length || forbidden.length) {
        throw new Error(
          `Candidate exceeds task scope: ${[...outside, ...forbidden].join(", ")}.`,
        );
      }
      const uncommitted = changedFiles(root).filter(
        (file) => !run.baseline_dirty_files.includes(file),
      );
      if (uncommitted.length) {
        throw new Error(
          `Candidate has uncommitted task changes: ${uncommitted.join(", ")}.`,
        );
      }
    }

    return this.store.update((latest) => {
      const current = taskAndRun(latest, taskId);
      let reuseDecision: ReuseDecision | null = null;
      if (input.reuseDecision) {
        const classification = classifyReuseTier(current.task);
        reuseDecision = {
          id: id("reuse-decision"),
          task_id: taskId,
          capability_keyword: classification.matchedKeywords[0] ?? "general",
          requirement: input.reuseDecision.requirement,
          checked_repo: input.reuseDecision.checkedRepo,
          checked_existing_dependencies:
            input.reuseDecision.checkedExistingDependencies,
          checked_native_capability:
            input.reuseDecision.checkedNativeCapability,
          external_candidate: input.reuseDecision.externalCandidate ?? null,
          decision: input.reuseDecision.decision,
          selected_solution: input.reuseDecision.selectedSolution,
          reason: input.reuseDecision.reason,
          created_at: timestamp(),
        };
        latest.reuse_decisions.push(reuseDecision);
      }
      const result: DeveloperResult = {
        id: id("developer-result"),
        task_id: taskId,
        run_id: current.run.id,
        status: input.status.toLowerCase() as DeveloperResult["status"],
        summary: input.summary,
        changed_files: actualFiles,
        candidate_commit: candidate,
        known_issues: input.knownIssues,
        reuse_decision: reuseDecision,
        created_at: timestamp(),
      };
      latest.developer_results.push(result);
      current.run.developer_result_id = result.id;
      current.run.result = input.status;
      current.task.candidate_commit = candidate;
      current.task.commit = candidate;
      current.task.harness_status = "not_run";
      current.task.qa_status = "not_run";
      current.task.last_failed_check = null;
      current.task.updated_at = result.created_at;
      return result;
    });
  }

  /**
   * Runs the harness for the submitted candidate with the gate's own runner
   * (never the agent's self-reported results). Status is "error" when a check
   * could not run at all, "fail" when checks ran and failed, else "pass".
   */
  async runIndependentHarness(
    taskId: string,
    runner: HarnessCheckRunner = this.runner,
  ): Promise<HarnessReport> {
    const before = await this.store.read();
    const { task, run } = taskAndRun(before, taskId);
    const developer = before.developer_results.find(
      (item) => item.id === run.developer_result_id,
    );
    const base = run.baseline_head;
    const candidate = task.candidate_commit;
    if (developer?.status !== "implemented" || !base || !candidate) {
      throw new Error(
        "A valid IMPLEMENTED developer result and candidate commit are required.",
      );
    }

    await this.store.update((state) => {
      const current = taskAndRun(state, taskId);
      current.task.harness_status = "running";
      state.events.push(
        makeEvent("HARNESS_STARTED", {
          run_id: run.id,
          task_id: taskId,
          candidate_commit: candidate,
        }),
      );
    });

    const started = performance.now();
    const root = this.repoRoot;
    const mode = selectHarnessMode(task, this.config);
    const commands = harnessCommands(task, mode, this.config);
    const results: CheckResult[] = [];
    let structuralError: string | null = null;
    let runnerError: string | null = null;
    if (
      currentHead(root) !== candidate ||
      !commitIsAncestor(root, base, candidate)
    ) {
      structuralError =
        "Checked-out commit does not match the submitted candidate.";
    } else {
      const execute = async (command: string): Promise<void> => {
        try {
          results.push(await runner(command, root));
        } catch (error) {
          const details = `Harness runner error for ${command}: ${(error as Error).message}`;
          runnerError ??= details;
          results.push({ command, passed: false, errored: true, details });
        }
      };
      for (const command of commands) await execute(command);
      for (const criterion of task.acceptance_criteria) {
        if (
          criterion.verification_type === "deterministic" &&
          criterion.verification
        ) {
          await execute(criterion.verification);
        }
      }
    }

    const deterministicIndexes = task.acceptance_criteria.flatMap(
      (criterion, index) =>
        criterion.verification_type === "deterministic" ? [index] : [],
    );
    const acceptancePassed = deterministicIndexes.filter((index) => {
      const criterion = task.acceptance_criteria[index];
      return Boolean(
        criterion?.verification &&
          results.find((item) => item.command === criterion.verification)
            ?.passed,
      );
    });
    const acceptanceFailed = deterministicIndexes.filter(
      (index) => !acceptancePassed.includes(index),
    );
    const failed = results.filter((item) => !item.passed);
    const executionErrors = results.filter((item) => item.errored);
    const status: HarnessReport["status"] =
      structuralError || runnerError || executionErrors.length
        ? "error"
        : failed.length || acceptanceFailed.length
          ? "fail"
          : "pass";
    const report: HarnessReport = {
      id: id("harness"),
      task_id: taskId,
      run_id: run.id,
      base_commit: base,
      candidate_commit: candidate,
      mode,
      status,
      checks_run: results.map((item) => item.command),
      checks_passed: results
        .filter((item) => item.passed)
        .map((item) => item.command),
      checks_failed: failed.map((item) => item.command),
      check_evidence: results.map((item) => ({
        command: item.command,
        status: item.passed ? "pass" : item.errored ? "error" : "fail",
        details: item.details,
      })),
      acceptance_passed: acceptancePassed,
      acceptance_failed: acceptanceFailed,
      regressions: structuralError
        ? [structuralError]
        : failed.map((item) => item.details),
      duration_ms: Math.round(performance.now() - started),
      artifacts: results.flatMap((item) => item.artifacts ?? []),
      created_at: timestamp(),
    };

    return this.store.update((state) => {
      const current = taskAndRun(state, taskId);
      state.harness_reports.push(report);
      current.run.harness_report_ids.push(report.id);
      current.task.harness_status = report.status;
      current.task.last_failed_check =
        report.checks_failed[0] ?? structuralError ?? runnerError;
      for (const result of results) {
        state.events.push(
          makeEvent(
            result.passed
              ? "HARNESS_CHECK_PASSED"
              : result.errored
                ? "HARNESS_CHECK_ERRORED"
                : "HARNESS_CHECK_FAILED",
            {
              run_id: run.id,
              task_id: taskId,
              candidate_commit: candidate,
              details: result.command,
            },
          ),
        );
      }
      state.events.push(
        makeEvent("HARNESS_COMPLETED", {
          run_id: run.id,
          task_id: taskId,
          candidate_commit: candidate,
          details: report.status,
        }),
      );
      return report;
    });
  }

  /**
   * Builds the QA prompt for the latest harness report and records its size.
   * Refuses unless the report is bound to the current candidate.
   */
  async startQaReviewEnvelope(
    taskId: string,
    options: { attempt?: number; measuredAt?: string } = {},
  ): Promise<BuiltPrompt> {
    const state = await this.store.read();
    const { task, run } = taskAndRun(state, taskId);
    const report = state.harness_reports
      .filter((item) => item.run_id === run.id)
      .at(-1);
    if (!report || !task.candidate_commit || !run.baseline_head) {
      throw new Error(
        "Harness report and commit-bound candidate are required before QA.",
      );
    }
    if (
      report.base_commit !== run.baseline_head ||
      report.candidate_commit !== task.candidate_commit
    ) {
      throw new Error(
        "A fresh Harness report for the current candidate is required before QA.",
      );
    }
    const candidate = task.candidate_commit;
    const built = buildQaPromptEnvelope(
      task,
      run.baseline_head,
      candidate,
      report,
      commitDiff(this.repoRoot, run.baseline_head, candidate),
      state.qa_reviews.filter((item) => item.task_id === taskId),
      Math.min(
        task.context_budget_chars ?? this.config.qa.taskContextBudgetChars,
        remainingRunContextBudget(run, this.config),
      ),
    );
    const measuredAt = options.measuredAt ?? timestamp();
    await this.store.update((latest) => {
      const current = taskAndRun(latest, taskId);
      const runBudget =
        current.run.context_budget_chars ?? this.config.qa.runContextBudgetChars;
      // Same floored calculation the prompt was built against; otherwise
      // this guard could reject the very prompt the floor just allowed.
      const remainingBefore = remainingRunContextBudget(
        current.run,
        this.config,
      );
      if (built.usage.promptChars > remainingBefore) {
        throw new Error(
          `QA prompt for ${taskId} exceeds run context budget: ${built.usage.promptChars} > ${remainingBefore} remaining characters.`,
        );
      }
      current.run.context_usage.push({
        attempt: options.attempt ?? Math.max(1, current.task.attempts),
        mode: "qa",
        fresh_context: true,
        run_budget_chars: runBudget,
        run_budget_remaining_chars: remainingBefore - built.usage.promptChars,
        budget_chars: built.usage.budgetChars,
        prompt_chars: built.usage.promptChars,
        prompt_utf8_bytes: built.usage.promptUtf8Bytes,
        included_sections: built.usage.includedSections,
        truncated_sections: built.usage.truncatedSections,
        omitted_sections: built.usage.omittedSections,
        measured_at: measuredAt,
      });
      current.task.qa_status = "running";
      current.run.updated_at = measuredAt;
      latest.events.push(
        makeEvent("QA_STARTED", {
          run_id: run.id,
          task_id: taskId,
          candidate_commit: candidate,
        }),
      );
    });
    return built;
  }

  async startQaReview(taskId: string): Promise<string> {
    return (await this.startQaReviewEnvelope(taskId)).prompt;
  }

  /**
   * Records the reviewer's decision. A PASS is rejected by a hard gate unless
   * the harness is green for this exact candidate, no deterministic criterion
   * failed, and no manual criterion is open; the model's opinion alone can
   * never accept a change.
   */
  async recordQaDecision(taskId: string, raw: unknown): Promise<QaReview> {
    const input = qaDecisionInputSchema.parse(raw);
    const outcome = await this.store.update(
      (
        state,
      ): { review: QaReview | null; rejection: string | null } => {
        const { task, run } = taskAndRun(state, taskId);
        const candidate = task.candidate_commit;
        const developer = state.developer_results.find(
          (item) => item.id === run.developer_result_id,
        );
        const report = state.harness_reports
          .filter((item) => item.run_id === run.id)
          .at(-1);
        if (
          !candidate ||
          !developer ||
          developer.candidate_commit !== candidate ||
          !report ||
          report.base_commit !== run.baseline_head ||
          report.candidate_commit !== candidate
        ) {
          throw new Error(
            "QA decision is not bound to a valid developer candidate and harness report.",
          );
        }
        const manualOpen = task.acceptance_criteria.some(
          (criterion) =>
            criterion.verification_type === "manual_required" &&
            !criterion.met,
        );
        const passForbidden =
          report.status !== "pass" ||
          report.acceptance_failed.length > 0 ||
          manualOpen;
        if (input.decision === "PASS" && passForbidden) {
          // The rejection is recorded and returned, not thrown from inside
          // the transaction: a throw would discard this very audit event.
          state.events.push(
            makeEvent("TASK_REJECTED", {
              run_id: run.id,
              task_id: taskId,
              candidate_commit: candidate,
              details: "Invalid QA PASS rejected by hard gate.",
            }),
          );
          return {
            review: null,
            rejection:
              "Hard QA gate rejected PASS: harness, commit, deterministic acceptance, or manual acceptance is not green.",
          };
        }

        const decision = input.decision.toLowerCase() as QaReview["decision"];
        const review: QaReview = {
          id: id("qa"),
          task_id: taskId,
          run_id: run.id,
          harness_report_id: report.id,
          candidate_commit: candidate,
          decision,
          reason: input.reason,
          required_changes: input.requiredChanges,
          verification: input.verification,
          severity: "severity" in input ? input.severity : null,
          created_at: timestamp(),
        };
        state.qa_reviews.push(review);
        run.qa_review_ids.push(review.id);
        task.qa_status = decision;
        task.last_error =
          decision === "pass" ? null : formatQaFollowUpNote(review);
        state.events.push(
          makeEvent(`QA_${input.decision}` as GateEventType, {
            run_id: run.id,
            task_id: taskId,
            candidate_commit: candidate,
            details: input.reason,
          }),
        );
        if (decision === "pass") {
          for (const criterion of task.acceptance_criteria) {
            if (criterion.verification_type !== "manual_required")
              criterion.met = true;
          }
        } else {
          state.events.push(
            makeEvent("TASK_REJECTED", {
              run_id: run.id,
              task_id: taskId,
              candidate_commit: candidate,
              details: input.reason,
            }),
          );
          if (decision === "retry") {
            task.attempts += 1;
            task.candidate_commit = null;
            task.commit = null;
            task.harness_status = "not_run";
            task.qa_status = "retry";
            run.developer_result_id = null;
          } else {
            task.status = "blocked";
            run.status = "blocked";
            run.completed_at = review.created_at;
            if (decision === "rollback") {
              task.last_error = `${formatQaFollowUpNote(review)}\n\nSafe rollback: create a new revert commit for ${candidate}; do not reset or rewrite history.`;
            }
          }
        }
        task.updated_at = review.created_at;
        run.updated_at = review.created_at;
        return { review, rejection: null };
      },
    );
    if (outcome.rejection) throw new Error(outcome.rejection);
    if (!outcome.review) throw new Error("QA decision was not recorded.");
    return outcome.review;
  }

  // -- completion -----------------------------------------------------------

  /** Pure read: why a task cannot be accepted yet (empty list = it can). */
  evaluateCompletion(state: GateState, task: GateTask): QualityGateEvaluation {
    const failures: string[] = [];
    if (task.acceptance_criteria.some((criterion) => !criterion.met)) {
      failures.push("Not all acceptance criteria are marked met.");
    }
    const run = state.runs.find((item) => item.id === task.active_run_id);
    if (!run) {
      failures.push("Task has no active run.");
      return { passed: false, failures };
    }
    const report = state.harness_reports
      .filter((item) => item.run_id === run.id)
      .at(-1);
    if (!task.candidate_commit || task.commit !== task.candidate_commit) {
      failures.push("A commit-bound candidate is required.");
    }
    if (
      report?.status !== "pass" ||
      report?.candidate_commit !== task.candidate_commit
    ) {
      failures.push("Independent harness is not green for this candidate.");
    }
    const qa = state.qa_reviews
      .filter((item) => item.run_id === run.id)
      .at(-1);
    if (
      qa?.decision !== "pass" ||
      qa?.candidate_commit !== task.candidate_commit ||
      qa.harness_report_id !== report?.id
    ) {
      failures.push("Independent QA has not accepted this harness report.");
    }
    const dirty = changedFiles(this.repoRoot);
    const undeclared = dirty.filter(
      (path) => !task.allowed_paths.some((rule) => pathMatches(rule, path)),
    );
    const forbidden = dirty.filter((path) =>
      task.forbidden_paths.some((rule) => pathMatches(rule, path)),
    );
    if (undeclared.length > 0) {
      failures.push(`Undeclared changed files: ${undeclared.join(", ")}.`);
    }
    if (forbidden.length > 0) {
      failures.push(`Forbidden changed files: ${forbidden.join(", ")}.`);
    }
    if (task.commit) {
      const uncommitted = dirty.filter(
        (path) => !run.baseline_dirty_files.includes(path),
      );
      if (uncommitted.length > 0) {
        failures.push(
          `Task changes remain uncommitted after the recorded commit: ${uncommitted.join(", ")}.`,
        );
      }
    }
    if (!task.commit) failures.push("Candidate commit is required.");
    return { passed: failures.length === 0, failures };
  }

  /** Accepts a task only if `evaluateCompletion` finds no failure. */
  async completeTask(
    taskId: string,
    options: { commit?: string } = {},
  ): Promise<GateTask> {
    const outcome = await this.store.update(
      (state): { task: GateTask; failures: string[] } => {
        const task = taskById(state, taskId);
        if (task.status !== "validating" && task.status !== "in_progress") {
          throw new Error(
            `Task ${taskId} cannot complete while ${task.status}.`,
          );
        }
        const { run } = taskAndRun(state, taskId);
        if (options.commit) {
          task.commit = verifyCommit(this.repoRoot, options.commit, taskId);
        }
        const gate = this.evaluateCompletion(state, task);
        if (!gate.passed) {
          // Persist the reason (not thrown inside the transaction).
          task.last_error = gate.failures.join(" ");
          return { task, failures: gate.failures };
        }
        const completedAt = timestamp();
        task.status = "done";
        task.active_run_id = null;
        task.last_error = null;
        task.updated_at = completedAt;
        run.status = "completed";
        run.result = "Quality gate passed.";
        run.updated_at = completedAt;
        run.completed_at = completedAt;
        state.events.push(
          makeEvent("TASK_ACCEPTED", {
            run_id: run.id,
            task_id: task.id,
            candidate_commit: task.candidate_commit ?? task.commit ?? "missing",
            details: "Independent harness and QA passed.",
          }),
        );
        for (const blocker of state.blockers.filter(
          (item) => item.task_id === taskId && item.status === "open",
        )) {
          blocker.status = "resolved";
          blocker.resolved_at = completedAt;
        }
        return { task, failures: [] };
      },
    );
    if (outcome.failures.length > 0) {
      throw new Error(
        `Quality gate failed:\n- ${outcome.failures.join("\n- ")}`,
      );
    }
    return outcome.task;
  }

  // -- blocking and recovery ------------------------------------------------

  async blockTask(
    taskId: string,
    reason: string,
    humanAction: string,
  ): Promise<void> {
    await this.store.update((state) => {
      const task = taskById(state, taskId);
      if (task.status === "done") {
        throw new Error(`Done task ${taskId} cannot be blocked.`);
      }
      createBlocker(state, task, reason, humanAction);
    });
  }

  /** Re-opens a blocked task (without a run) so it can be claimed again. */
  async release(taskId: string): Promise<void> {
    await this.store.update((state) => {
      const task = taskById(state, taskId);
      if (task.status !== "blocked") {
        throw new Error(`Task ${taskId} cannot be released while ${task.status}.`);
      }
      const at = timestamp();
      task.status = "ready";
      task.active_run_id = null;
      task.last_error = null;
      task.updated_at = at;
      for (const blocker of state.blockers.filter(
        (item) => item.task_id === taskId && item.status === "open",
      )) {
        blocker.status = "resolved";
        blocker.resolved_at = at;
      }
    });
  }

  /**
   * Recovery for a QA reviewer that failed for infrastructure reasons rather
   * than a demonstrated defect. Reopens the blocked task for one more
   * independent QA pass without a new developer attempt; the candidate,
   * harness report and context telemetry are preserved. A QA ROLLBACK is
   * deliberately not recoverable this way.
   */
  async requeueQaAfterReviewInfrastructureFailure(
    taskId: string,
    reason: string,
  ): Promise<{ task: GateTask; run: GateRun }> {
    return this.store.update((state) => {
      const task = taskById(state, taskId);
      if (task.status !== "blocked") {
        throw new Error(
          `Task ${taskId} cannot be requeued for QA while ${task.status} (only a QA-blocked task qualifies).`,
        );
      }
      if (task.qa_status !== "block") {
        throw new Error(
          `Task ${taskId} was blocked by qa_status=${task.qa_status}, not a QA "block" decision; this recovery path only reopens QA, it does not overturn a rollback or restart a developer attempt.`,
        );
      }
      if (!task.active_run_id) {
        throw new Error(`Task ${taskId} has no run to requeue QA for.`);
      }
      const run = state.runs.find((item) => item.id === task.active_run_id);
      if (!run) {
        throw new Error(`Run ${task.active_run_id} for ${taskId} not found.`);
      }
      if (run.status !== "blocked") {
        throw new Error(
          `Run ${run.id} is not in a blocked state (${run.status}); refusing to requeue QA.`,
        );
      }
      if (!task.candidate_commit || task.harness_status !== "pass") {
        throw new Error(
          `Task ${taskId} needs a passing harness report and candidate commit already on record to requeue QA without a new developer attempt.`,
        );
      }
      const report = state.harness_reports
        .filter((item) => item.run_id === run.id)
        .at(-1);
      if (
        !report ||
        report.base_commit !== run.baseline_head ||
        report.candidate_commit !== task.candidate_commit
      ) {
        throw new Error(
          `Task ${taskId} has no Harness report bound to the current candidate; re-run the Harness before requeuing QA.`,
        );
      }
      const reopenedAt = timestamp();
      task.status = "validating";
      task.qa_status = "not_run";
      task.last_error = null;
      run.status = "running";
      run.completed_at = null;
      run.updated_at = reopenedAt;
      task.updated_at = reopenedAt;
      state.events.push(
        makeEvent("QA_REQUEUED", {
          run_id: run.id,
          task_id: taskId,
          candidate_commit: task.candidate_commit,
          details: reason,
        }),
      );
      return { task, run };
    });
  }

  /**
   * Recovery for a task that holds a valid QA PASS while still marked blocked
   * (e.g. the reviewer infrastructure failure was recorded as a blocker before
   * any decision existed). Restores the completion-eligible shape without
   * re-deciding QA or touching the recorded review.
   */
  async resumeBlockedTaskAfterQaPass(
    taskId: string,
    reason: string,
  ): Promise<{ task: GateTask; run: GateRun }> {
    return this.store.update((state) => {
      const task = taskById(state, taskId);
      if (task.status !== "blocked") {
        throw new Error(
          `Task ${taskId} cannot resume after QA PASS while ${task.status} (only a blocked task qualifies).`,
        );
      }
      if (task.qa_status !== "pass") {
        throw new Error(
          `Task ${taskId} has qa_status=${task.qa_status}, not a recorded QA PASS; this recovery path only resumes a task that already carries a valid QA PASS.`,
        );
      }
      if (task.harness_status !== "pass") {
        throw new Error(
          `Task ${taskId} has harness_status=${task.harness_status}; a passing Harness report is required to resume.`,
        );
      }
      if (!task.candidate_commit) {
        throw new Error(`Task ${taskId} has no candidate_commit to resume with.`);
      }
      if (!task.active_run_id) {
        throw new Error(`Task ${taskId} has no run to resume.`);
      }
      const run = state.runs.find((item) => item.id === task.active_run_id);
      if (!run) {
        throw new Error(`Run ${task.active_run_id} for ${taskId} not found.`);
      }
      if (run.status !== "blocked") {
        throw new Error(
          `Run ${run.id} is not in a blocked state (${run.status}); refusing to resume.`,
        );
      }
      const review = state.qa_reviews
        .filter((item) => item.run_id === run.id)
        .at(-1);
      if (
        !review ||
        review.decision !== "pass" ||
        review.candidate_commit !== task.candidate_commit
      ) {
        throw new Error(
          `Task ${taskId} has no QA PASS review bound to the current candidate; record a valid QA decision before resuming.`,
        );
      }
      const report = state.harness_reports
        .filter((item) => item.run_id === run.id)
        .at(-1);
      if (
        !report ||
        report.status !== "pass" ||
        report.candidate_commit !== task.candidate_commit ||
        report.base_commit !== run.baseline_head
      ) {
        throw new Error(
          `Task ${taskId} has no Harness PASS report bound to the current candidate; re-run the Harness before resuming.`,
        );
      }
      const resumedAt = timestamp();
      task.status = "validating";
      task.last_error = null;
      run.status = "running";
      run.completed_at = null;
      run.updated_at = resumedAt;
      task.updated_at = resumedAt;
      for (const blocker of state.blockers.filter(
        (item) => item.task_id === taskId && item.status === "open",
      )) {
        blocker.status = "resolved";
        blocker.resolved_at = resumedAt;
      }
      state.events.push(
        makeEvent("TASK_UNBLOCKED", {
          run_id: run.id,
          task_id: taskId,
          candidate_commit: task.candidate_commit,
          details: reason,
        }),
      );
      return { task, run };
    });
  }

  // -- security audit trail -------------------------------------------------

  async recordSecurityEvent(input: SecurityEventInput): Promise<GateEvent> {
    return this.store.update((state) => {
      const event = makeEvent(input.type, {
        run_id: input.sessionId ?? null,
        task_id: input.taskId ?? null,
        details: input.reason,
        agent: input.agent ?? null,
        requested_action: input.requestedAction,
        source: input.source,
        trust_level: input.trustLevel,
        decision: input.decision,
        reason: input.reason,
      });
      state.events.push(event);
      return event;
    });
  }

  /**
   * Turns a non-SAFE security decision into an audit event and, if a task is
   * named, blocks that task for a human. SAFE decisions are a no-op.
   */
  async enforceSecurityDecision(
    input: Omit<SecurityEventInput, "type" | "decision" | "reason"> & {
      securityDecision: SecurityDecision;
    },
  ): Promise<void> {
    const { securityDecision, ...context } = input;
    if (securityDecision.decision === "SAFE") return;
    await this.recordSecurityEvent({
      ...context,
      type: securityDecision.eventType ?? "PERMISSION_DENIED",
      decision: securityDecision.decision,
      reason: securityDecision.reason,
    });
    if (input.taskId) {
      await this.blockTask(
        input.taskId,
        securityDecision.reason,
        "Review the requested action and explicitly approve a safe scope if appropriate.",
      );
    }
  }
}
