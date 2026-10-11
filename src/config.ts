import { readFileSync } from "node:fs";
import { z } from "zod";

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

const regexSource = z
  .string()
  .min(1)
  .refine(isValidRegex, { message: "must be a valid regular expression" });

const extraRiskCategorySchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  /** Regular-expression source, compiled case-insensitively. */
  pattern: regexSource,
});

/**
 * Everything project-specific lives here. The defaults contain no product
 * names, repository paths or domain vocabulary; see
 * `quality-gate.config.example.json` for a filled-in example.
 */
export const configSchema = z
  .object({
    harness: z
      .object({
        /** Command run in "full" mode (medium/high risk, retries, risky paths). */
        fullCommand: z.string().min(1).default("npm run check"),
        /** Always run in "smoke" mode, before the task's own required checks. */
        smokeBaseCommands: z
          .array(z.string().min(1))
          .default(["npm run typecheck"]),
        /**
         * npm scripts a smoke run may invoke directly. A required check that is
         * not listed here escalates the run to `fullCommand`.
         */
        knownScripts: z
          .array(z.string().min(1))
          .default([
            "biome:check",
            "lint",
            "typecheck",
            "test",
            "build",
            "test:e2e",
          ]),
        /** Globs: a task whose allowed_paths touch these always gets "full". */
        fullRiskPaths: z
          .array(z.string().min(1))
          .default(["**/*auth*", "**/*ledger*", "**/*payment*"]),
        /** Per-command timeout for the production check runner. */
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(60 * 60_000),
      })
      .strict()
      .prefault({}),
    security: z
      .object({
        /** Absolute directories allowed in addition to the repository root. */
        additionalWorkspaces: z.array(z.string().min(1)).default([]),
        /** Hosts that upload-like commands may talk to (case-insensitive). */
        approvedNetworkHosts: z.array(z.string().min(1)).default([]),
        /** `npm run <script>` names classified SAFE without review. */
        safeNpmScripts: z
          .array(z.string().min(1))
          .default([
            "check",
            "build",
            "typecheck",
            "lint",
            "test",
            "test:e2e",
            "biome:check",
            "format:check",
          ]),
      })
      .strict()
      .prefault({}),
    risk: z
      .object({
        maxLowRiskScopePaths: z.number().int().positive().default(5),
        /** Paths that always need a human (regex source, tested on posix paths). */
        protectedPathPattern: regexSource.default(
          "^(?:\\.env|data/|data$|backups/|backups$|\\.git/|\\.git$)",
        ),
        /** Sensitive subtrees (regex source). */
        sensitivePathPattern: regexSource.default(
          "(^|/)(auth|security|permissions?|middleware/auth|migrations?|payments?|billing|deploy|\\.github/workflows)(/|$)",
        ),
        /** Read-only research tasks must stay inside this prefix to be exempt. */
        researchScopePrefix: z.string().min(1).default("docs/research/"),
        /**
         * Names under which the product refers to itself. Used only by the
         * market-research exemption: it is granted only if the task text does
         * NOT combine one of these names with a mutation verb and a money
         * noun. With an empty list the exemption is disabled (fail closed).
         */
        projectNames: z.array(z.string().min(1)).default([]),
        /** Extra literal words appended to a built-in category, by id. */
        extraKeywords: z
          .record(z.string(), z.array(z.string().min(1)))
          .default({}),
        /** Whole additional categories. Any match makes a task "high". */
        extraCategories: z.array(extraRiskCategorySchema).default([]),
      })
      .strict()
      .prefault({}),
    size: z
      .object({
        maxAllowedPaths: z.number().int().positive().default(8),
        maxAcceptanceCriteria: z.number().int().positive().default(5),
        maxSubsystems: z.number().int().positive().default(2),
        maxDependencies: z.number().int().nonnegative().default(5),
        maxEstimatedDurationMs: z
          .number()
          .int()
          .positive()
          .default(90 * 60_000),
        maxDescriptionLength: z.number().int().positive().default(1200),
        /** First segments whose second segment also names the subsystem. */
        twoLevelRoots: z
          .array(z.string().min(1))
          .default(["apps", "packages", "tools"]),
      })
      .strict()
      .prefault({}),
    reuse: z
      .object({
        /** Optional path of a capability inventory mentioned in the prompt. */
        registryPath: z.string().min(1).nullable().default(null),
      })
      .strict()
      .prefault({}),
    qa: z
      .object({
        taskContextBudgetChars: z.number().int().positive().default(24_000),
        runContextBudgetChars: z.number().int().positive().default(72_000),
        minContextBudgetChars: z.number().int().positive().default(8_000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type QualityGateConfig = z.output<typeof configSchema>;
export type QualityGateConfigInput = z.input<typeof configSchema>;

/** Validates a (possibly partial) config object and fills in defaults. */
export function resolveConfig(
  input: QualityGateConfigInput = {},
): QualityGateConfig {
  return configSchema.parse(input);
}

export const defaultConfig: QualityGateConfig = resolveConfig({});

/**
 * Reads a JSON config file. A top-level "$comment" key is ignored so example
 * files can carry documentation.
 */
export function loadConfigFile(path: string): QualityGateConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${path}`);
  }
  const { $comment: _comment, ...rest } = parsed as Record<string, unknown>;
  return resolveConfig(rest as QualityGateConfigInput);
}

/** Compiles a configured regex source (case-insensitive). */
export function compilePattern(source: string): RegExp {
  return new RegExp(source, "i");
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
