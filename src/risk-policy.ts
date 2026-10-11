import {
  compilePattern,
  defaultConfig,
  escapeRegex,
  type QualityGateConfig,
} from "./config.js";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskInput {
  title: string;
  description: string;
  rationale: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: Array<{ text: string }>;
  required_checks: string[];
}

export interface RiskClassification {
  level: RiskLevel;
  reasons: string[];
}

interface BuiltInCategory {
  id: string;
  reason: string;
  /** Regular-expression source (compiled case-insensitively). */
  pattern: string;
}

/**
 * Generic categories. Every category is a hard "not low-risk" signal: the
 * classifier's job is to keep money, production, security and irreversible
 * actions out of autonomous approval, not to grade them. Project vocabulary
 * is added through `config.risk.extraKeywords` / `extraCategories`.
 */
const builtInCategories: BuiltInCategory[] = [
  {
    id: "payment_economy",
    reason:
      "mentions payments, pricing, or refunds, so the money flow requires manual approval",
    pattern:
      "\\b(payment|paying|refunds?|billing|invoice|checkout|pric(e|ing))\\b|стоимост\\w*|цен[аыу]\\w*|оплат\\w*|возврат\\w*\\s*средств|платеж\\w*",
  },
  {
    id: "production_mutation",
    reason: "mentions production or deployment, which requires manual approval",
    pattern:
      "\\b(production|prod\\b|deploy(ment|ing)?|rollout|release to (users|prod))\\b|продакшн\\w*|публикаци\\w*",
  },
  {
    id: "secrets_credentials",
    reason: "mentions secrets, credentials, tokens, or API keys",
    pattern:
      "\\b(secrets?|credentials?|api[ -]?key|apikey|password|private key|access token)\\b|\\.env\\b",
  },
  {
    id: "data_deletion",
    reason: "mentions deleting/dropping/purging data",
    pattern:
      "\\b(drop\\s+table|drop\\s+database|truncate(\\s+table)?|purge\\s+data|wipe\\s+data|delete\\s+(all|the)?\\s*(data|records?|rows?|users?|table))\\b|удал\\w*\\s*данн\\w*|очистит\\w*\\s*баз\\w*",
  },
  {
    id: "dangerous_migration",
    reason: "mentions a destructive/irreversible database migration",
    pattern:
      "\\bmigrations?\\b.*\\b(drop|alter|truncate|remove column|irreversible|destructive)\\b|опасн\\w*\\s*миграци\\w*",
  },
  {
    id: "external_account_integration",
    reason:
      "mentions an external account or integration that needs authorization",
    pattern:
      "\\b(oauth|webhook secret|third[- ]party (integration|api|service)|external service (credential|account)|connect (a|the) new (account|service))\\b",
  },
  {
    id: "security_auth_permissions",
    reason: "touches security, authentication, authorization, or permissions",
    pattern:
      "\\b(auth(entication|orization)?|permissions?|role[- ]based access|rbac|security (policy|rule|review)|session token|jwt|access control)\\b",
  },
  {
    id: "business_economy",
    reason: "changes the product's business economics",
    pattern:
      "\\b(reward amount|drop rate|payout|economy balance)\\b|игров\\w*\\s*эконом\\w*",
  },
  {
    id: "destructive_git",
    reason:
      "mentions a destructive git operation (force-push, reset --hard, rebase, push)",
    pattern:
      "\\b(force[- ]?push|push\\s+--force|reset\\s+--hard|git\\s+push|rebase|delete\\s+branch|--no-verify)\\b",
  },
  {
    id: "irreversible_action",
    reason: "mentions an irreversible or mass/broadcast action",
    pattern:
      "\\b(irreversible|cannot be undone|no rollback|permanent(ly)?\\s*(delete|remove)|broadcast\\s*(message|notification)|mass\\s*(message|notify)|send\\s*to\\s*all\\s*users)\\b",
  },
  {
    id: "prohibited_external_action",
    reason:
      "mentions logging in, purchasing, messaging/contacting someone, creating an account, entering credentials, or bypassing a paywall; outside read-only public research or existing scope rules",
    pattern:
      "\\b(log(?:ging)?\\s*in(?:to)?|sign(?:ing)?\\s*in(?:to)?|creat(?:e|ing)\\s+an?\\s+account|purchas(?:e|ing)|buy(?:ing)?\\s+(?:a|an|the)|send(?:ing)?\\s+a?\\s*message|(?:contact|message|email)(?:ing)?\\s+(?:the|a)\\s+(?:company|vendor|support|team)|bypass(?:ing)?\\s+(?:a\\s+)?(?:paywall|access\\s+control)|enter(?:ing)?\\s+credentials)\\b",
  },
];

interface CompiledCategory {
  id: string;
  reason: string;
  pattern: RegExp;
}

const compiledCache = new WeakMap<QualityGateConfig, CompiledCategory[]>();

function compileCategories(config: QualityGateConfig): CompiledCategory[] {
  const cached = compiledCache.get(config);
  if (cached) return cached;
  const compiled: CompiledCategory[] = builtInCategories.map((category) => {
    const extras = config.risk.extraKeywords[category.id] ?? [];
    const source =
      extras.length > 0
        ? `(?:${category.pattern})|\\b(?:${extras.map(escapeRegex).join("|")})\\b`
        : category.pattern;
    return {
      id: category.id,
      reason: category.reason,
      pattern: compilePattern(source),
    };
  });
  for (const extra of config.risk.extraCategories) {
    compiled.push({
      id: extra.id,
      reason: extra.reason,
      pattern: compilePattern(extra.pattern),
    });
  }
  compiledCache.set(config, compiled);
  return compiled;
}

function textHaystack(input: RiskInput): string {
  return [input.title, input.description, input.rationale ?? ""].join("\n");
}

function posix(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Explicit, minimal stand-in for a "research task" marker: the title says so. */
const researchTitlePattern = /\bresearch\b/i;
const economyMutationVerbPattern =
  /\b(change|update|increase|decrease|modify|adjust|introduce|remove|reduce|raise|lower|cut|alter|set)\w*\b/i;
const economyNounPattern =
  /\b(pric(?:e|es|ing)|reward|payment|payout|economy|fee)\b/i;

/**
 * True when one sentence names the project itself, a mutation verb and a
 * money noun together, in any order. That is the one shape the research
 * exemption must never wave through: scope alone cannot rule it out, since a
 * task could claim a research-docs scope while its text still asks for a real
 * economics change. Anchoring on the project name (rather than verb + noun
 * alone) keeps ordinary research language such as "how competitors set their
 * price" from tripping the check.
 */
function mentionsProjectEconomyMutation(
  haystack: string,
  projectNames: string[],
): boolean {
  if (projectNames.length === 0) return false;
  const projectPattern = new RegExp(
    `\\b(?:${projectNames.map(escapeRegex).join("|")})(?:'s)?\\b`,
    "i",
  );
  return haystack
    .split(/(?<=[.!?\n])/)
    .some(
      (sentence) =>
        projectPattern.test(sentence) &&
        economyMutationVerbPattern.test(sentence) &&
        economyNounPattern.test(sentence),
    );
}

/**
 * The one narrow exception: a task studying someone else's pricing/payments
 * as the *subject* of research is not the same risk as touching the
 * product's own money flow, provided ALL hold at once:
 * - at least one project name is configured (otherwise fail closed);
 * - every allowed path stays under `risk.researchScopePrefix`;
 * - the title marks the task as research;
 * - no sentence combines a project name, a mutation verb and a money noun.
 * Every other category is never exempted.
 */
function isReadOnlyMarketResearch(
  input: RiskInput,
  config: QualityGateConfig,
): boolean {
  const { projectNames, researchScopePrefix } = config.risk;
  if (projectNames.length === 0) return false;
  if (input.allowed_paths.length === 0) return false;
  const prefix = posix(researchScopePrefix).toLowerCase();
  const inScope = input.allowed_paths.every((path) =>
    posix(path).toLowerCase().startsWith(prefix),
  );
  if (!inScope) return false;
  if (!researchTitlePattern.test(input.title)) return false;
  if (mentionsProjectEconomyMutation(textHaystack(input), projectNames))
    return false;
  return true;
}

/**
 * Pure, deterministic risk classifier for a PROPOSED task. A task is "low"
 * only when no signal fires; any single hit downgrades it to "medium"/"high".
 */
export function classifyTaskRisk(
  input: RiskInput,
  config: QualityGateConfig = defaultConfig,
): RiskClassification {
  const reasons: string[] = [];
  let hasHighSignal = false;
  const readOnlyMarketResearch = isReadOnlyMarketResearch(input, config);
  const protectedPathPattern = compilePattern(config.risk.protectedPathPattern);
  const sensitivePathPattern = compilePattern(config.risk.sensitivePathPattern);

  const haystack = textHaystack(input);
  for (const category of compileCategories(config)) {
    if (category.id === "payment_economy" && readOnlyMarketResearch) continue;
    if (category.pattern.test(haystack)) {
      reasons.push(category.reason);
      hasHighSignal = true;
    }
  }

  const protectedPath = input.allowed_paths.find((path) =>
    protectedPathPattern.test(posix(path)),
  );
  if (protectedPath) {
    reasons.push(`scope includes a protected path (${protectedPath})`);
    hasHighSignal = true;
  }

  const sensitivePath = input.allowed_paths.find((path) =>
    sensitivePathPattern.test(path.replaceAll("\\", "/")),
  );
  if (sensitivePath) {
    reasons.push(`scope touches a sensitive area (${sensitivePath})`);
    hasHighSignal = true;
  }

  if (input.acceptance_criteria.length === 0) {
    reasons.push("no acceptance criteria recorded");
  }
  if (input.required_checks.length === 0) {
    reasons.push("no required checks recorded");
  }
  const limit = config.risk.maxLowRiskScopePaths;
  if (input.allowed_paths.length > limit) {
    reasons.push(
      `scope spans ${input.allowed_paths.length} paths (auto-approve limit: ${limit})`,
    );
  }

  if (reasons.length === 0) return { level: "low", reasons: [] };
  return { level: hasHighSignal ? "high" : "medium", reasons };
}
