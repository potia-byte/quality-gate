import type { ReuseDecision } from "./reuse-gate.js";
import type { RiskLevel } from "./risk-policy.js";
import type { TrustLevel, SecurityDecisionName } from "./security-policy.js";

export type TaskStatus =
  | "ready"
  | "in_progress"
  | "validating"
  | "done"
  | "blocked";

export type VerificationType =
  | "deterministic"
  | "llm_review_required"
  | "manual_required";

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
  verification_type: VerificationType;
  /** For "deterministic" criteria: the command whose success proves it. */
  verification: string | null;
}

export type HarnessStatus = "not_run" | "running" | "pass" | "fail" | "error";
export type QaStatus =
  | "not_run"
  | "running"
  | "pass"
  | "retry"
  | "block"
  | "rollback";

export interface GateTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  depends_on: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: AcceptanceCriterion[];
  required_checks: string[];
  allow_existing_changes: boolean;
  estimated_duration_ms: number | null;
  rationale: string | null;
  risk_level: RiskLevel | null;
  risk_reasons: string[];
  attempts: number;
  last_error: string | null;
  commit: string | null;
  candidate_commit: string | null;
  harness_status: HarnessStatus;
  qa_status: QaStatus;
  last_failed_check: string | null;
  active_run_id: string | null;
  context_budget_chars?: number | undefined;
  created_at: string;
  updated_at: string;
}

export interface ContextUsage {
  attempt: number;
  mode: "qa";
  fresh_context: true;
  run_budget_chars: number;
  run_budget_remaining_chars: number;
  budget_chars: number;
  prompt_chars: number;
  prompt_utf8_bytes: number;
  included_sections: string[];
  truncated_sections: string[];
  omitted_sections: string[];
  measured_at: string;
}

export interface GateRun {
  id: string;
  task_id: string;
  agent: string;
  status: "running" | "validating" | "completed" | "blocked";
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  baseline_head: string | null;
  baseline_dirty_files: string[];
  result: string | null;
  developer_result_id: string | null;
  harness_report_ids: string[];
  qa_review_ids: string[];
  context_budget_chars?: number | undefined;
  context_usage: ContextUsage[];
}

export interface DeveloperResult {
  id: string;
  task_id: string;
  run_id: string;
  status: "implemented" | "failed" | "blocked";
  summary: string;
  changed_files: string[];
  candidate_commit: string | null;
  known_issues: string[];
  reuse_decision: ReuseDecision | null;
  created_at: string;
}

export interface CheckEvidence {
  command: string;
  status: "pass" | "fail" | "error";
  details: string;
}

export interface HarnessReport {
  id: string;
  task_id: string;
  run_id: string;
  base_commit: string;
  candidate_commit: string;
  mode: "smoke" | "full";
  status: "pass" | "fail" | "error";
  checks_run: string[];
  checks_passed: string[];
  checks_failed: string[];
  check_evidence: CheckEvidence[];
  acceptance_passed: number[];
  acceptance_failed: number[];
  regressions: string[];
  duration_ms: number;
  artifacts: string[];
  created_at: string;
}

export interface QaReview {
  id: string;
  task_id: string;
  run_id: string;
  harness_report_id: string;
  candidate_commit: string;
  decision: "pass" | "retry" | "block" | "rollback";
  reason: string;
  required_changes: string[];
  verification: string[];
  severity: string | null;
  created_at: string;
}

export type GateEventType =
  | "HARNESS_STARTED"
  | "HARNESS_CHECK_PASSED"
  | "HARNESS_CHECK_FAILED"
  | "HARNESS_CHECK_ERRORED"
  | "HARNESS_COMPLETED"
  | "QA_STARTED"
  | "QA_PASS"
  | "QA_RETRY"
  | "QA_BLOCK"
  | "QA_ROLLBACK"
  | "QA_REQUEUED"
  | "TASK_UNBLOCKED"
  | "TASK_ACCEPTED"
  | "TASK_REJECTED"
  | "PROMPT_INJECTION_SUSPECTED"
  | "SECRET_ACCESS_BLOCKED"
  | "DANGEROUS_COMMAND_BLOCKED"
  | "EXTERNAL_CODE_REVIEW_REQUIRED"
  | "PERMISSION_DENIED"
  | "WORKSPACE_BOUNDARY_BLOCKED"
  | "SIZE_GATE_FLAGGED";

export interface GateEvent {
  id: string;
  type: GateEventType;
  run_id: string | null;
  task_id: string | null;
  candidate_commit: string | null;
  details: string | null;
  agent: string | null;
  requested_action: string | null;
  source: string | null;
  trust_level: TrustLevel | null;
  decision: SecurityDecisionName | null;
  reason: string | null;
  created_at: string;
}

export interface Blocker {
  id: string;
  task_id: string;
  run_id: string | null;
  reason: string;
  required_human_action: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

export interface GateState {
  version: 1;
  tasks: GateTask[];
  runs: GateRun[];
  developer_results: DeveloperResult[];
  harness_reports: HarnessReport[];
  qa_reviews: QaReview[];
  reuse_decisions: ReuseDecision[];
  events: GateEvent[];
  blockers: Blocker[];
  updated_at: string;
}

export function initialState(now = new Date().toISOString()): GateState {
  return {
    version: 1,
    tasks: [],
    runs: [],
    developer_results: [],
    harness_reports: [],
    qa_reviews: [],
    reuse_decisions: [],
    events: [],
    blockers: [],
    updated_at: now,
  };
}
