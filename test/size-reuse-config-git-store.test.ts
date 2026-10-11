import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyReuseTier,
  defaultConfig,
  developerResultJsonSchema,
  evaluateSizeGate,
  FileStore,
  findCachedReuseDecision,
  fitPromptSections,
  initialState,
  loadConfigFile,
  MemoryStore,
  pathMatches,
  type ReuseDecision,
  remainingRunContextBudget,
  resolveConfig,
  resolveReuseContext,
  reuseGateSectionText,
  subsystemOf,
  withFsRetry,
} from "../src/index.js";
import { cleanupRepositories, tempDirectory } from "./helpers.js";

afterEach(cleanupRepositories);

describe("Size Gate", () => {
  const small = {
    description: "Fix a typo",
    allowed_paths: ["src/a.ts"],
    acceptance_criteria: ["done"],
    depends_on: [],
  };

  it("passes a small task", () => {
    expect(evaluateSizeGate(small)).toMatchObject({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("names every tripped signal", () => {
    const result = evaluateSizeGate({
      description: "x".repeat(1300),
      allowed_paths: Array.from({ length: 9 }, (_, i) => `apps/a${i}/f.ts`),
      acceptance_criteria: [1, 2, 3, 4, 5, 6],
      depends_on: [1, 2, 3, 4, 5, 6],
    });
    expect(result.verdict).toBe("MUST_DECOMPOSE");
    expect(result.reasons).toHaveLength(5);
    expect(result.signals.subsystemCount).toBe(9);
  });

  it("uses estimated duration instead of description length when present", () => {
    const long = { ...small, description: "x".repeat(2000) };
    expect(evaluateSizeGate(long).verdict).toBe("MUST_DECOMPOSE");
    expect(
      evaluateSizeGate({ ...long, estimated_duration_ms: 60_000 }).verdict,
    ).toBe("PASS");
    expect(
      evaluateSizeGate({ ...small, estimated_duration_ms: 91 * 60_000 }).verdict,
    ).toBe("MUST_DECOMPOSE");
  });

  it("counts apps/web and apps/server as distinct subsystems", () => {
    expect(subsystemOf("apps/web/src/x.ts")).toBe("apps/web");
    expect(subsystemOf("docs/readme.md")).toBe("docs");
    expect(subsystemOf("README.md")).toBe("README.md");
    expect(subsystemOf("services/api/x.ts", ["services"])).toBe("services/api");
  });

  it("honors configured limits", () => {
    const config = resolveConfig({ size: { maxAllowedPaths: 1 } });
    expect(
      evaluateSizeGate(
        { ...small, allowed_paths: ["src/a.ts", "src/b.ts"] },
        config,
      ).verdict,
    ).toBe("MUST_DECOMPOSE");
  });
});

describe("Reuse-First Gate", () => {
  function decision(overrides: Partial<ReuseDecision> = {}): ReuseDecision {
    return {
      id: "reuse-decision-1",
      task_id: "TASK-0",
      capability_keyword: "queue",
      requirement: "background job queue",
      checked_repo: true,
      checked_existing_dependencies: true,
      checked_native_capability: false,
      external_candidate: null,
      decision: "REUSE_EXISTING",
      selected_solution: "existing job runner",
      reason: "already has at-least-once semantics",
      created_at: "2026-09-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("classifies a plain bug fix as standard", () => {
    expect(
      classifyReuseTier({
        title: "Fix off-by-one in points calculation",
        description: "The daily bonus is off by one on leap years.",
      }),
    ).toEqual({ tier: "standard", matchedKeywords: [] });
  });

  it("classifies infrastructure keywords", () => {
    const result = classifyReuseTier({
      title: "Add a retry queue",
      description: "Introduce a scheduler with caching of the database rows.",
    });
    expect(result.tier).toBe("infrastructure");
    expect(result.matchedKeywords).toEqual(
      expect.arrayContaining(["queue", "scheduler", "cach", "database"]),
    );
  });

  it("returns the newest cached decision for a matched keyword", () => {
    const decisions = [
      decision({ id: "a", created_at: "2026-09-01T00:00:00.000Z" }),
      decision({ id: "b", created_at: "2026-09-02T00:00:00.000Z" }),
      decision({ id: "c", capability_keyword: "parser" }),
    ];
    expect(findCachedReuseDecision(decisions, ["queue"])?.id).toBe("b");
    expect(findCachedReuseDecision(decisions, ["auth"])).toBeNull();
  });

  it("builds a prompt section; the registry line appears only when configured", () => {
    const context = resolveReuseContext([decision()], {
      title: "Add a queue",
      description: "background work",
    });
    expect(context?.cached?.id).toBe("reuse-decision-1");
    const without = reuseGateSectionText(context!);
    expect(without).toContain("Reuse-First Gate");
    expect(without).not.toContain("REGISTRY");
    const withRegistry = reuseGateSectionText(
      context!,
      resolveConfig({ reuse: { registryPath: "docs/REGISTRY.md" } }),
    );
    expect(withRegistry).toContain("docs/REGISTRY.md");
    expect(
      resolveReuseContext([], { title: "Fix typo", description: "docs" }),
    ).toBeNull();
  });
});

describe("configuration", () => {
  it("has defaults that contain no project-specific terms", () => {
    const serialized = JSON.stringify(defaultConfig).toLowerCase();
    expect(serialized).not.toContain("giftquest");
    expect(serialized).not.toContain("packages/db");
    expect(serialized).not.toContain("apps/server");
    expect(defaultConfig.risk.projectNames).toEqual([]);
  });

  it("rejects unknown top-level and nested keys", () => {
    expect(() => resolveConfig({ bogus: true } as never)).toThrow();
    expect(() => resolveConfig({ harness: { nope: 1 } } as never)).toThrow();
  });

  it("loads the shipped example file", () => {
    const config = loadConfigFile(
      join(import.meta.dirname, "..", "quality-gate.config.example.json"),
    );
    expect(config.risk.projectNames).toContain("Acme");
    expect(config.harness.fullRiskPaths).toContain("packages/db/**");
  });

  it("rejects a config file that is not a JSON object", () => {
    const dir = tempDirectory();
    const file = join(dir, "c.json");
    writeFileSync(file, "[]");
    expect(() => loadConfigFile(file)).toThrow("JSON object");
  });
});

describe("pathMatches", () => {
  it.each([
    ["**", "anything/at/all.ts", true],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src", true],
    ["src/**", "srcx/a.ts", false],
    ["docs/", "docs/a.md", true],
    ["**/*.test.ts", "last.test.ts", true],
    ["**/*.test.ts", "a/b/c.test.ts", true],
    ["*.md", "a/README.md", false],
    ["*.md", "README.md", true],
    ["./work.txt", "work.txt", true],
    ["src\\a.ts", "src/a.ts", true],
    ["work.txt", "work.txt.bak", false],
  ])("pathMatches(%s, %s) = %s", (rule, candidate, expected) => {
    expect(pathMatches(rule, candidate)).toBe(expected);
  });
});

describe("prompt budget", () => {
  it("omits optional sections that do not fit and throws for required ones", () => {
    const built = fitPromptSections(
      [
        { name: "a", text: "aaaa" },
        { name: "b", text: "b".repeat(50), optional: true },
      ],
      20,
    );
    expect(built.usage.includedSections).toEqual(["a"]);
    expect(built.usage.omittedSections).toEqual(["b"]);
    expect(() =>
      fitPromptSections([{ name: "req", text: "x".repeat(50) }], 10),
    ).toThrow("too small for required prompt section req");
  });

  it("floors the remaining run budget", () => {
    expect(
      remainingRunContextBudget({
        context_budget_chars: 10_000,
        context_usage: [{ prompt_chars: 9_900 }],
      }),
    ).toBe(8_000);
  });

  it("exposes the developer envelope as a JSON Schema without $schema", () => {
    const schema = developerResultJsonSchema as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(
      expect.arrayContaining(["status", "candidateCommit", "changedFiles"]),
    );
  });
});

describe("ledger stores", () => {
  it("discards every change when the transaction throws", async () => {
    const store = new MemoryStore();
    await expect(
      store.update((state) => {
        state.events.push({ id: "e" } as never);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.read()).events).toHaveLength(0);
    // The queue must survive a failed transaction.
    await store.update((state) => {
      state.blockers.push({ id: "b" } as never);
    });
    expect((await store.read()).blockers).toHaveLength(1);
  });

  it("serializes concurrent updates without losing any", async () => {
    const store = new MemoryStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update((state) => {
          state.events.push({ id: `e${i}` } as never);
        }),
      ),
    );
    expect((await store.read()).events).toHaveLength(25);
  });

  it("persists to a file, survives re-opening, and ignores the ledger dir in git status", async () => {
    const dir = tempDirectory();
    const store = FileStore.forRepository(dir);
    await store.update((state) => {
      state.blockers.push({ id: "b1" } as never);
    });
    const reopened = FileStore.forRepository(dir);
    expect((await reopened.read()).blockers[0]?.id).toBe("b1");
    expect(store.path.replaceAll("\\", "/")).toContain(".quality-gate/state.json");
  });

  it("rejects a ledger file of an unknown format", async () => {
    const dir = tempDirectory();
    mkdirSync(join(dir, ".quality-gate"));
    const file = join(dir, ".quality-gate", "state.json");
    writeFileSync(file, JSON.stringify({ version: 99 }));
    await expect(new FileStore(file).read()).rejects.toThrow(
      "Unrecognized ledger format",
    );
  });

  it("starts from an initial state when the file does not exist", async () => {
    const dir = tempDirectory();
    const state = await FileStore.forRepository(dir).read();
    expect(state.tasks).toEqual([]);
    expect(state.version).toBe(1);
    expect(JSON.parse(JSON.stringify(initialState())).version).toBe(1);
    expect(() =>
      readFileSync(join(dir, ".quality-gate", "state.json")),
    ).toThrow();
  });
});

describe("withFsRetry (Windows transient EPERM/EBUSY)", () => {
  function fsError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  it("retries a transient EPERM and then succeeds", async () => {
    let calls = 0;
    const result = await withFsRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw fsError("EPERM");
        return "ok";
      },
      { delayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      withFsRetry(async () => {
        calls += 1;
        throw fsError("ENOENT");
      }),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      withFsRetry(
        async () => {
          calls += 1;
          throw fsError("EBUSY");
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);
  });
});
