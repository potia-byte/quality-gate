import { describe, expect, it } from "vitest";
import {
  classifyTaskRisk,
  type QualityGateConfigInput,
  type RiskInput,
  resolveConfig,
} from "../src/index.js";

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    title: "Add unit tests for the retry helper",
    description: "Cover the existing retry helper with focused unit tests.",
    rationale: "Evidence-backed: the helper has no direct test coverage.",
    allowed_paths: ["test/retry-helper.test.ts"],
    forbidden_paths: [".env*", "data/**"],
    acceptance_criteria: [{ text: "New tests pass" }],
    required_checks: ["targeted"],
    ...overrides,
  };
}

const acme: QualityGateConfigInput = {
  risk: {
    projectNames: ["Acme"],
    extraKeywords: { payment_economy: ["stars", "ton", "usdt"] },
  },
};

describe("classifyTaskRisk (default config)", () => {
  it("classifies a narrow, well-specified task as low risk", () => {
    expect(classifyTaskRisk(input())).toEqual({ level: "low", reasons: [] });
  });

  it("flags payments/pricing/refund mentions", () => {
    const result = classifyTaskRisk(
      input({
        title: "Add payment refund handling for purchases",
        description: "Let users request a refund when a payment fails.",
      }),
    );
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.includes("payments"))).toBe(
      true,
    );
  });

  it("flags Russian money vocabulary", () => {
    const result = classifyTaskRisk(
      input({ description: "Изменить расчёт стоимости и возврат средств." }),
    );
    expect(result.level).toBe("high");
  });

  it("flags production/deployment mentions", () => {
    const result = classifyTaskRisk(
      input({
        title: "Deploy the worker service to production",
        description: "Roll out the new worker to the production environment.",
      }),
    );
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.includes("production"))).toBe(
      true,
    );
  });

  it("flags a protected .env/data/backups/.git scope even without a keyword hit", () => {
    const result = classifyTaskRisk(
      input({ allowed_paths: ["data/exports/report.csv"] }),
    );
    expect(result.level).toBe("high");
    expect(
      result.reasons.some((reason) => reason.includes("protected path")),
    ).toBe(true);
  });

  it("flags a sensitive subtree even without a keyword hit", () => {
    const result = classifyTaskRisk(
      input({ allowed_paths: ["src/migrations/0001_init.sql"] }),
    );
    expect(result.level).toBe("high");
    expect(
      result.reasons.some((reason) => reason.includes("sensitive area")),
    ).toBe(true);
  });

  it("flags security/auth/permissions mentions", () => {
    const result = classifyTaskRisk(
      input({
        title: "Harden the authentication middleware permissions",
        description: "Tighten role-based access checks in the auth layer.",
      }),
    );
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.includes("security"))).toBe(
      true,
    );
  });

  it("flags destructive git operations and data deletion", () => {
    expect(
      classifyTaskRisk(
        input({ description: "Run git push --force to sync the branch." }),
      ).level,
    ).toBe("high");
    expect(
      classifyTaskRisk(
        input({ description: "Delete all rows from the legacy users table." }),
      ).level,
    ).toBe("high");
  });

  it("keeps missing acceptance criteria / checks at medium", () => {
    const result = classifyTaskRisk(
      input({ acceptance_criteria: [], required_checks: [] }),
    );
    expect(result.level).toBe("medium");
    expect(result.reasons).toEqual([
      "no acceptance criteria recorded",
      "no required checks recorded",
    ]);
  });

  it("flags scope beyond the configured low-risk path limit", () => {
    const wide = Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`);
    const result = classifyTaskRisk(input({ allowed_paths: wide }));
    expect(result.level).toBe("medium");
    expect(
      result.reasons.some((reason) => reason.includes("scope spans")),
    ).toBe(true);
    const relaxed = resolveConfig({ risk: { maxLowRiskScopePaths: 6 } });
    expect(classifyTaskRisk(input({ allowed_paths: wide }), relaxed).level).toBe(
      "low",
    );
  });

  it("does not know project-specific terms unless configured", () => {
    const text = {
      title: "Tune the TON exchange rate",
      description: "Adjust the loyalty points accrual.",
    };
    expect(classifyTaskRisk(input(text)).reasons).toEqual([]);
    const configured = resolveConfig({
      risk: {
        extraKeywords: { payment_economy: ["ton"] },
        extraCategories: [
          {
            id: "loyalty",
            reason: "changes loyalty economics",
            pattern: "loyalty points?",
          },
        ],
      },
    });
    const result = classifyTaskRisk(input(text), configured);
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("payments"),
        "changes loyalty economics",
      ]),
    );
  });

  it("rejects an invalid configured pattern", () => {
    expect(() =>
      resolveConfig({
        risk: { extraCategories: [{ id: "x", reason: "x", pattern: "(" }] },
      }),
    ).toThrow();
  });
});

describe("classifyTaskRisk: read-only market research exemption", () => {
  const config = resolveConfig(acme);

  it("treats read-only research about a competitor's pricing as low risk", () => {
    const result = classifyTaskRisk(
      input({
        title: "Research: how competitor offerwalls price advertiser actions",
        description:
          "Document how 3-5 competitor platforms set the price of an advertiser action and structure Stars/TON/USDT-equivalent payouts, using only their public pricing pages. Update docs/research/MARKET.md in place.",
        allowed_paths: ["docs/research/MARKET.md"],
      }),
      config,
    );
    expect(result).toEqual({ level: "low", reasons: [] });
  });

  it("is disabled (fails closed) when no project name is configured", () => {
    const result = classifyTaskRisk(
      input({
        title: "Research: competitor pricing",
        description: "Study how competitors set the price of a subscription.",
        allowed_paths: ["docs/research/MARKET.md"],
      }),
    );
    expect(result.level).toBe("high");
  });

  it("keeps a task that would change the project's own pricing high risk even when labeled research", () => {
    const result = classifyTaskRisk(
      input({
        title: "Research: adjust Acme's Stars pricing based on findings",
        description:
          "Change Acme's Stars pricing to match competitor rates and update the reward payout accordingly.",
        allowed_paths: ["docs/research/RECOMMENDATIONS.md"],
      }),
      config,
    );
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.includes("payments"))).toBe(
      true,
    );
  });

  it("keeps a research task with product-code scope high risk", () => {
    const result = classifyTaskRisk(
      input({
        title: "Research: analyze competitor UX and pricing display patterns",
        description:
          "Study competitor onboarding flows and pricing display patterns, then also touch apps/web/src/Onboarding.tsx.",
        allowed_paths: [
          "docs/research/MARKET.md",
          "apps/web/src/Onboarding.tsx",
        ],
      }),
      config,
    );
    expect(result.level).toBe("high");
  });

  it("keeps a research task that requires an external action (logging in) high risk", () => {
    const result = classifyTaskRisk(
      input({
        title: "Research: competitor onboarding via their signup portal",
        description:
          "Log into a competitor's dashboard to see private pricing tiers, then update docs/research/MARKET.md.",
        allowed_paths: ["docs/research/MARKET.md"],
      }),
      config,
    );
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.includes("logging in"))).toBe(
      true,
    );
  });

  it("does not exempt a task whose title never says 'research'", () => {
    const result = classifyTaskRisk(
      input({
        title: "Update the market pricing notes",
        description: "Note how competitors price advertiser actions.",
        allowed_paths: ["docs/research/MARKET.md"],
      }),
      config,
    );
    expect(result.level).not.toBe("low");
  });
});
