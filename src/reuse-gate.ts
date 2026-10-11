import { z } from "zod";
import { defaultConfig, type QualityGateConfig } from "./config.js";

export const reuseDecisionOutcomeSchema = z.enum([
  "REUSE_EXISTING",
  "USE_NATIVE",
  "ADAPT_EXTERNAL",
  "ADD_DEPENDENCY",
  "WRITE_MINIMAL_CUSTOM",
]);
export type ReuseDecisionOutcome = z.infer<typeof reuseDecisionOutcomeSchema>;

/** A recorded "did you check for an existing solution?" answer. */
export interface ReuseDecision {
  id: string;
  task_id: string;
  capability_keyword: string;
  requirement: string;
  checked_repo: boolean;
  checked_existing_dependencies: boolean;
  checked_native_capability: boolean;
  external_candidate: string | null;
  decision: ReuseDecisionOutcome;
  selected_solution: string;
  reason: string;
  created_at: string;
}

export type ReuseTier = "standard" | "infrastructure";

export interface ReuseTierClassification {
  tier: ReuseTier;
  matchedKeywords: string[];
}

/**
 * Keyword -> regex, one per generic-infrastructure category. Matching is
 * intentionally coarse (title + description only, no semantic understanding):
 * it only decides whether the optional reuse-first prompt section appears.
 */
const INFRASTRUCTURE_KEYWORDS: Array<[string, RegExp]> = [
  ["queue", /\bqueue(s|ing)?\b/i],
  ["scheduler", /\bschedul(er|ing|e)\b/i],
  ["orchestration", /\borchestrat(e|ion|or)\b/i],
  ["worktree", /\bworktree(s)?\b/i],
  ["retry framework", /\bretry\s+(framework|engine|policy)\b/i],
  ["browser automation", /\bbrowser\s+automation\b|\bheadless\s+browser\b/i],
  ["parser", /\bpars(e|er|ing)\b/i],
  ["auth", /\bauth(entication|orization)?\b/i],
  ["database", /\bdatabase(s)?\b|\bDB\b/],
  ["cach", /\bcach(e|ing|ed)\b/i],
  ["telemetry", /\btelemetry\b|\bmetrics?\s+collection\b/i],
  ["retrieval", /\bretrieval\b|\bcontext\s+retrieval\b/i],
  ["agent orchestration", /\bagent\s+orchestration\b|\bmulti-agent\b/i],
  ["token optimization", /\btoken\s+(optimization|budget|reduction)\b/i],
  [
    "testing infrastructure",
    /\btest(ing)?\s+infrastructure\b|\btest\s+harness\b/i,
  ],
];

export function classifyReuseTier(input: {
  title: string;
  description: string;
}): ReuseTierClassification {
  const text = `${input.title}\n${input.description}`;
  const matchedKeywords: string[] = [];
  for (const [keyword, pattern] of INFRASTRUCTURE_KEYWORDS) {
    if (pattern.test(text)) matchedKeywords.push(keyword);
  }
  return {
    tier: matchedKeywords.length > 0 ? "infrastructure" : "standard",
    matchedKeywords,
  };
}

/** Newest earlier decision that covers any of the matched keywords. */
export function findCachedReuseDecision(
  decisions: ReuseDecision[],
  matchedKeywords: string[],
): ReuseDecision | null {
  const keywordSet = new Set(matchedKeywords);
  const matches = decisions.filter((entry) =>
    keywordSet.has(entry.capability_keyword),
  );
  if (matches.length === 0) return null;
  return matches.reduce((latest, entry) =>
    entry.created_at > latest.created_at ? entry : latest,
  );
}

export interface ReusePromptContext {
  tier: ReuseTier;
  matchedKeywords: string[];
  cached: ReuseDecision | null;
}

export function resolveReuseContext(
  decisions: ReuseDecision[],
  task: { title: string; description: string },
): ReusePromptContext | null {
  const classification = classifyReuseTier(task);
  if (classification.tier !== "infrastructure") return null;
  return {
    tier: classification.tier,
    matchedKeywords: classification.matchedKeywords,
    cached: findCachedReuseDecision(decisions, classification.matchedKeywords),
  };
}

/** Prompt section asking an agent to justify new infrastructure code. */
export function reuseGateSectionText(
  context: ReusePromptContext,
  config: QualityGateConfig = defaultConfig,
): string {
  const keywordList = context.matchedKeywords.join(", ");
  const registry = config.reuse.registryPath
    ? ` See ${config.reuse.registryPath} for capabilities already inventoried.`
    : "";
  const cachedText = context.cached
    ? `A prior Reuse Decision already covered a similar capability (task ${context.cached.task_id}, ${context.cached.created_at}): decision=${context.cached.decision}, selected_solution="${context.cached.selected_solution}", reason="${context.cached.reason}". Reuse this finding unless this task's requirement genuinely differs; do not re-research it from scratch.`
    : "No cached Reuse Decision matched this capability yet.";
  return `Reuse-First Gate: this task was classified as INFRASTRUCTURE/GENERIC CAPABILITY (matched: ${keywordList}). Before writing custom code, check in order: (1) this repo, (2) an installed dependency, (3) a native runtime/platform capability, (4) a small mature external OSS component, (5) only then the minimum necessary custom code.${registry} ${cachedText} Include a "reuseDecision" field in your final JSON object with this shape: {"requirement":"...","checkedRepo":true|false,"checkedExistingDependencies":true|false,"checkedNativeCapability":true|false,"externalCandidate":"..."|null,"decision":"REUSE_EXISTING|USE_NATIVE|ADAPT_EXTERNAL|ADD_DEPENDENCY|WRITE_MINIMAL_CUSTOM","selectedSolution":"...","reason":"..."}.`;
}
