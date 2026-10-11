import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QualityGate } from "../src/index.js";
import {
  claimedGate,
  cleanupRepositories,
  commitAll,
  commitCandidate,
  git,
  greenRunner,
  repository,
  submit,
} from "./helpers.js";

afterEach(cleanupRepositories);

describe("commit-bound independent quality gate", () => {
  it("rejects a malformed developer result", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await expect(
      gate.submitDeveloperResult("TASK-1", { status: "IMPLEMENTED" }),
    ).rejects.toThrow();
    expect((await gate.state()).tasks[0]?.harness_status).toBe("not_run");
  });

  it("rejects a candidate commit that is not current HEAD", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root, "first candidate\n");
    commitCandidate(root, "unsubmitted successor\n");
    await expect(submit(gate, candidate)).rejects.toThrow(
      "current checked-out HEAD",
    );
    expect((await gate.state()).tasks[0]?.harness_status).toBe("not_run");
  });

  it("rejects a commit whose message does not name the task", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    writeFileSync(join(root, "work.txt"), "implemented\n");
    const candidate = commitAll(root, "unrelated message");
    await expect(submit(gate, candidate)).rejects.toThrow(
      "must contain task id TASK-1",
    );
  });

  it("rejects a changedFiles declaration that omits a deleted file", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    unlinkSync(join(root, "work.txt"));
    const candidate = commitAll(root, "TASK-1 delete candidate");
    await expect(
      gate.submitDeveloperResult("TASK-1", {
        status: "IMPLEMENTED",
        summary: "Deleted the task file.",
        changedFiles: [],
        candidateCommit: candidate,
        knownIssues: [],
      }),
    ).rejects.toThrow("actual: work.txt");
  });

  it("rejects a candidate that touches a file outside allowed_paths", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    writeFileSync(join(root, "work.txt"), "implemented\n");
    writeFileSync(join(root, "README.md"), "also edited\n");
    const candidate = commitAll(root, "TASK-1 candidate with scope creep");
    await expect(
      gate.submitDeveloperResult("TASK-1", {
        status: "IMPLEMENTED",
        summary: "Edited two files.",
        changedFiles: ["README.md", "work.txt"],
        candidateCommit: candidate,
        knownIssues: [],
      }),
    ).rejects.toThrow("Candidate exceeds task scope: README.md");
  });

  it("blocks QA PASS when a real check fails", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    const report = await gate.runIndependentHarness("TASK-1", async (command) => ({
      command,
      passed: command !== "npm run test",
      details: command === "npm run test" ? "unit assertion failed" : "green",
    }));
    expect(report.status).toBe("fail");
    await gate.startQaReview("TASK-1");
    await expect(
      gate.recordQaDecision("TASK-1", {
        decision: "PASS",
        reason: "Faulty reviewer ignored the failure.",
        requiredChanges: [],
        verification: [],
      }),
    ).rejects.toThrow("Hard QA gate rejected PASS");
    const state = await gate.state();
    expect(state.tasks[0]?.status).not.toBe("done");
    // The rejection must be auditable: the event is persisted even though
    // the call throws.
    expect(state.events.map((item) => item.type)).toContain("TASK_REJECTED");
    expect(state.qa_reviews).toHaveLength(0);
  });

  it("rejects an unmet deterministic acceptance criterion and allows RETRY", async () => {
    const root = repository();
    const gate = await claimedGate(root, { deterministic: true });
    await submit(gate, commitCandidate(root));
    const report = await gate.runIndependentHarness("TASK-1", async (command) => ({
      command,
      passed: command !== "npm run test",
      details: "criterion failed",
    }));
    expect(report.acceptance_failed).toEqual([0]);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "RETRY",
      reason: "Acceptance is not met.",
      requiredChanges: ["Fix behavior"],
      verification: ["npm run test"],
    });
    const state = await gate.state();
    expect(state.tasks[0]?.qa_status).toBe("retry");
    expect(state.tasks[0]?.candidate_commit).toBeNull();
  });

  it("records Harness ERROR when the check runner throws", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    const report = await gate.runIndependentHarness("TASK-1", async () => {
      throw new Error("runner crashed");
    });
    const state = await gate.state();
    expect(report.status).toBe("error");
    expect(report.regressions).toContainEqual(
      expect.stringContaining("runner crashed"),
    );
    expect(state.tasks[0]?.harness_status).toBe("error");
    const types = state.events.map((item) => item.type);
    expect(types).toContain("HARNESS_COMPLETED");
    expect(types).toContain("HARNESS_CHECK_ERRORED");
    expect(types).not.toContain("HARNESS_CHECK_FAILED");
  });

  it("reports status ERROR (not FAIL) when a check is an execution error", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    const report = await gate.runIndependentHarness("TASK-1", async (command) => ({
      command,
      passed: false,
      errored: true,
      details: "spawn EINVAL",
    }));
    expect(report.status).toBe("error");
    expect((await gate.state()).tasks[0]?.harness_status).toBe("error");
  });

  it("reports status FAIL for an ordinary non-erroring check failure", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    const report = await gate.runIndependentHarness("TASK-1", async (command) => ({
      command,
      passed: false,
      details: "1 test failed",
    }));
    const state = await gate.state();
    expect(report.status).toBe("fail");
    const types = state.events.map((item) => item.type);
    expect(types).toContain("HARNESS_CHECK_FAILED");
    expect(types).not.toContain("HARNESS_CHECK_ERRORED");
  });

  it("records per-check evidence for every check, including passing ones", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    await submit(gate, candidate);
    const report = await gate.runIndependentHarness("TASK-1", async (command) =>
      command === "npm run test"
        ? { command, passed: true, details: "12 passed" }
        : { command, passed: false, errored: true, details: "spawn EINVAL" },
    );
    expect(report.check_evidence).toEqual(
      expect.arrayContaining([
        { command: "npm run test", status: "pass", details: "12 passed" },
      ]),
    );
    expect(report.candidate_commit).toBe(candidate);
  });

  it("requires a fresh candidate and harness report after QA RETRY", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const firstCandidate = commitCandidate(root, "first attempt\n");
    await submit(gate, firstCandidate);
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "RETRY",
      reason: "A semantic edge case remains.",
      requiredChanges: ["Handle the edge case"],
      verification: ["Review the new diff"],
    });

    const secondCandidate = commitCandidate(root, "second attempt\n");
    await submit(gate, secondCandidate);
    await expect(gate.startQaReview("TASK-1")).rejects.toThrow(
      "fresh Harness report",
    );
    await expect(
      gate.recordQaDecision("TASK-1", {
        decision: "RETRY",
        reason: "This must not use the stale report.",
        requiredChanges: ["Run the Harness"],
        verification: ["Review the fresh report"],
      }),
    ).rejects.toThrow("not bound");
    const secondReport = await gate.runIndependentHarness(
      "TASK-1",
      greenRunner,
    );
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "PASS",
      reason: "The replacement candidate fixes the edge case.",
      requiredChanges: [],
      verification: ["Fresh harness report reviewed"],
    });

    const state = await gate.state();
    expect(secondCandidate).not.toBe(firstCandidate);
    expect(secondReport.candidate_commit).toBe(secondCandidate);
    expect(state.harness_reports).toHaveLength(2);
    expect(state.qa_reviews).toHaveLength(2);
    expect(state.tasks[0]?.candidate_commit).toBe(secondCandidate);
    expect(state.tasks[0]?.qa_status).toBe("pass");
  });

  it("ends the task and run when independent QA blocks the candidate", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "BLOCK",
      reason: "A human decision is required.",
    });
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(state.runs[0]?.status).toBe("blocked");
  });

  it("records safe revert guidance for a QA ROLLBACK", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "ROLLBACK",
      reason: "The candidate introduces a severe regression.",
      severity: "critical",
    });
    const task = (await gate.state()).tasks[0];
    expect(task?.status).toBe("blocked");
    expect(task?.last_error).toContain("create a new revert commit");
    expect(task?.last_error).toContain("do not reset or rewrite history");
  });

  it("completes only after Harness PASS and independent QA PASS", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    await submit(gate, candidate);
    const report = await gate.runIndependentHarness("TASK-1", async (command) => ({
      command,
      passed: true,
      details: "green",
      artifacts: ["test-report"],
    }));
    expect(report.status).toBe("pass");
    expect(report.artifacts).toEqual(["test-report", "test-report"]);

    // Before QA there must be no way to accept the task.
    await expect(gate.completeTask("TASK-1")).rejects.toThrow(
      "Independent QA has not accepted this harness report",
    );

    const prompt = await gate.startQaReview("TASK-1");
    expect(prompt).toContain(candidate);
    await gate.recordQaDecision("TASK-1", {
      decision: "PASS",
      reason: "Diff satisfies the task without regressions.",
    });
    await gate.completeTask("TASK-1");
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.harness_reports).toHaveLength(1);
    expect(state.qa_reviews).toHaveLength(1);
    expect(state.events.map((item) => item.type)).toContain("TASK_ACCEPTED");
  });

  it("refuses completion when the working tree has undeclared changes", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", { decision: "PASS", reason: "ok" });
    writeFileSync(join(root, "stray.txt"), "left behind\n");
    await expect(gate.completeTask("TASK-1")).rejects.toThrow(
      "Undeclared changed files: stray.txt",
    );
    // The failure reason is persisted, not lost with the thrown error.
    const task = (await gate.state()).tasks[0];
    expect(task?.status).not.toBe("done");
    expect(task?.last_error).toContain("stray.txt");
  });

  it("builds independent QA from bounded run context", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const omittedTail = "OMITTED_DIFF_TAIL";
    await submit(
      gate,
      commitCandidate(root, `${"large diff line\n".repeat(4_000)}${omittedTail}\n`),
    );
    await gate.runIndependentHarness("TASK-1", greenRunner);

    const built = await gate.startQaReviewEnvelope("TASK-1");

    expect(built.prompt.length).toBeLessThanOrEqual(24_000);
    expect(built.prompt).toContain("fresh agent process");
    expect(built.prompt).not.toContain(omittedTail);
    expect(built.usage.includedSections).toContain("harness_summary");
    expect(built.usage.truncatedSections).toContain("candidate_diff");
    const state = await gate.state();
    expect(state.tasks[0]?.qa_status).toBe("running");
    expect(state.runs[0]?.context_usage.at(-1)).toMatchObject({
      mode: "qa",
      fresh_context: true,
      prompt_chars: built.prompt.length,
      prompt_utf8_bytes: Buffer.byteLength(built.prompt, "utf8"),
    });
  });

  it("drops verbose passing-check output from the QA prompt but keeps failing-check evidence", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    const verboseGreenOutput = "ok\n".repeat(4_000);
    const failureDetail = "FAILURE_MARKER: assertion mismatch on line 42";
    await gate.runIndependentHarness("TASK-1", async (command) =>
      command === "npm run test"
        ? { command, passed: false, details: failureDetail }
        : { command, passed: true, details: verboseGreenOutput },
    );

    const built = await gate.startQaReviewEnvelope("TASK-1");

    expect(built.prompt).toContain(failureDetail);
    expect(built.prompt).not.toContain(verboseGreenOutput);
    // Passing checks stay visible by name via harness_summary.
    expect(built.prompt).toContain("npm run typecheck");
  });

  it("carries QA's structured requiredChanges/verification forward", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "RETRY",
      reason: "Edge case not handled.",
      requiredChanges: ["Handle an empty input array", "Add a regression test"],
      verification: ["npm run test -- edge-case"],
    });
    const note = (await gate.state()).tasks[0]?.last_error;
    expect(note).toContain("Edge case not handled.");
    expect(note).toContain("Handle an empty input array");
    expect(note).toContain("Add a regression test");
    expect(note).toContain("npm run test -- edge-case");
  });

  it("requires at least one required change and verification step for RETRY", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await expect(
      gate.recordQaDecision("TASK-1", { decision: "RETRY", reason: "vague" }),
    ).rejects.toThrow();
  });
});

describe("claim: Size Gate and git safety", () => {
  it("blocks a task that must be decomposed and records an event", async () => {
    const root = repository();
    const gate = new QualityGate({ repoRoot: root });
    await gate.addTask({
      id: "BIG-1",
      title: "Huge",
      description: "Touch many things",
      allowed_paths: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
      acceptance_criteria: ["done"],
      required_checks: ["test"],
    });
    await expect(gate.claim("BIG-1", "codex")).rejects.toThrow(
      "requires decomposition",
    );
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(state.events.map((e) => e.type)).toContain("SIZE_GATE_FLAGGED");
    expect(state.blockers[0]?.status).toBe("open");
  });

  it("refuses to start on a dirty tree outside the task scope", async () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "dirty\n");
    const gate = new QualityGate({ repoRoot: root });
    await gate.addTask({
      id: "TASK-1",
      title: "Candidate",
      description: "Change work.txt",
      allowed_paths: ["work.txt"],
      acceptance_criteria: ["done"],
      required_checks: ["test"],
    });
    await expect(gate.claim("TASK-1", "codex")).rejects.toThrow(
      "blocked by git safety: Changes outside allowed_paths: README.md",
    );
  });

  it("can release a blocked task and claim it again", async () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "dirty\n");
    const gate = new QualityGate({ repoRoot: root });
    await gate.addTask({
      id: "TASK-1",
      title: "Candidate",
      description: "Change work.txt",
      allowed_paths: ["work.txt"],
      acceptance_criteria: ["done"],
      required_checks: ["test"],
    });
    await expect(gate.claim("TASK-1", "codex")).rejects.toThrow();
    git(root, "checkout", "--", "README.md");
    await gate.release("TASK-1");
    const run = await gate.claim("TASK-1", "codex");
    expect(run.baseline_head).toBe(git(root, "rev-parse", "HEAD"));
  });
});

describe("risk policy drives harness mode through addTask", () => {
  it("assigns a risk level and escalates a payment task to the full command", async () => {
    const root = repository();
    const gate = new QualityGate({ repoRoot: root });
    const task = await gate.addTask({
      id: "TASK-1",
      title: "Handle refunds for failed payments",
      description: "Change work.txt",
      allowed_paths: ["work.txt"],
      acceptance_criteria: ["done"],
      required_checks: ["test"],
    });
    expect(task.risk_level).toBe("high");
    await gate.claim("TASK-1", "codex");
    await submit(gate, commitCandidate(root));
    const commands: string[] = [];
    const report = await gate.runIndependentHarness("TASK-1", async (command) => {
      commands.push(command);
      return { command, passed: true, details: "green" };
    });
    expect(report.mode).toBe("full");
    expect(commands).toEqual(["npm run check"]);
  });
});

describe("QA reviewer-infrastructure-failure recovery", () => {
  async function blockedByInfrastructure(): Promise<{
    gate: QualityGate;
    candidate: string;
  }> {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    await submit(gate, candidate);
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "BLOCK",
      reason: "reviewer sandbox could not read the checkout.",
      requiredChanges: ["Restore read access to the candidate checkout."],
    });
    return { gate, candidate };
  }

  it("reopens a QA-blocked task for one more independent pass", async () => {
    const { gate, candidate } = await blockedByInfrastructure();
    const blocked = (await gate.state()).tasks[0];
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.qa_status).toBe("block");
    expect(blocked?.harness_status).toBe("pass");

    const reopened = await gate.requeueQaAfterReviewInfrastructureFailure(
      "TASK-1",
      "Reviewer sandbox failure, not a demonstrated candidate defect.",
    );
    expect(reopened.task.status).toBe("validating");
    expect(reopened.task.qa_status).toBe("not_run");
    expect(reopened.task.candidate_commit).toBe(candidate);
    expect(reopened.run.status).toBe("running");
    const afterReopen = await gate.state();
    expect(afterReopen.events.map((item) => item.type)).toContain(
      "QA_REQUEUED",
    );
    expect(afterReopen.runs).toHaveLength(1);
    expect(afterReopen.tasks[0]?.attempts).toBe(1);

    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "PASS",
      reason: "Verified against a readable checkout.",
    });
    await gate.completeTask("TASK-1");
    const done = (await gate.state()).tasks[0];
    expect(done?.status).toBe("done");
    expect(done?.commit).toBe(candidate);
  });

  it("refuses to requeue a task that is not QA-blocked", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await expect(
      gate.requeueQaAfterReviewInfrastructureFailure("TASK-1", "n/a"),
    ).rejects.toThrow("cannot be requeued for QA");
  });

  it("refuses to requeue a rollback decision", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await submit(gate, commitCandidate(root));
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", {
      decision: "ROLLBACK",
      reason: "Genuine security defect found.",
      severity: "high",
    });
    await expect(
      gate.requeueQaAfterReviewInfrastructureFailure("TASK-1", "n/a"),
    ).rejects.toThrow('not a QA "block" decision');
  });

  it("resumes a blocked task that already carries a bound QA PASS", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    await submit(gate, candidate);
    await gate.runIndependentHarness("TASK-1", greenRunner);
    await gate.startQaReview("TASK-1");
    await gate.recordQaDecision("TASK-1", { decision: "PASS", reason: "ok" });
    await gate.blockTask("TASK-1", "late infra failure", "re-check");
    expect((await gate.state()).tasks[0]?.status).toBe("blocked");

    await gate.resumeBlockedTaskAfterQaPass("TASK-1", "QA PASS is valid");
    await gate.completeTask("TASK-1");
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.blockers.every((b) => b.status === "resolved")).toBe(true);
  });
});

describe("developer result: reuse decision", () => {
  const reuse = {
    requirement: "delivery retry queue",
    checkedRepo: true,
    checkedExistingDependencies: true,
    checkedNativeCapability: false,
    externalCandidate: null,
    decision: "REUSE_EXISTING",
    selectedSolution: "existing retry loop",
    reason: "already retries with the same backoff semantics",
  };

  it("records a reuseDecision into the ledger and onto the DeveloperResult", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    const result = await gate.submitDeveloperResult("TASK-1", {
      status: "IMPLEMENTED",
      summary: "Implemented via existing queue.",
      changedFiles: ["work.txt"],
      candidateCommit: candidate,
      knownIssues: [],
      reuseDecision: reuse,
    });
    expect(result.reuse_decision?.decision).toBe("REUSE_EXISTING");
    expect(result.reuse_decision?.selected_solution).toBe("existing retry loop");
    const state = await gate.state();
    expect(state.reuse_decisions).toHaveLength(1);
    expect(state.reuse_decisions[0]?.task_id).toBe("TASK-1");
  });

  it("leaves reuse_decisions empty when none is supplied", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const result = await submit(gate, commitCandidate(root));
    expect(result.reuse_decision).toBeNull();
    expect((await gate.state()).reuse_decisions).toHaveLength(0);
  });

  it("rejects an unknown decision outcome", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    const candidate = commitCandidate(root);
    await expect(
      gate.submitDeveloperResult("TASK-1", {
        status: "IMPLEMENTED",
        summary: "x",
        changedFiles: ["work.txt"],
        candidateCommit: candidate,
        knownIssues: [],
        reuseDecision: { ...reuse, decision: "JUST_VIBES" },
      }),
    ).rejects.toThrow();
  });
});

describe("security audit trail", () => {
  it("blocks the task and records the event for a non-SAFE decision", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await gate.enforceSecurityDecision({
      taskId: "TASK-1",
      requestedAction: "cat .env",
      source: "README.md",
      trustLevel: "UNTRUSTED_EXTERNAL",
      securityDecision: {
        decision: "DENIED",
        eventType: "SECRET_ACCESS_BLOCKED",
        reason: "Secret path is denied by default: .env",
      },
    });
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(state.events.at(-1)?.type).toBe("SECRET_ACCESS_BLOCKED");
  });

  it("is a no-op for a SAFE decision", async () => {
    const root = repository();
    const gate = await claimedGate(root);
    await gate.enforceSecurityDecision({
      taskId: "TASK-1",
      requestedAction: "npm test",
      source: "gate",
      trustLevel: "TRUSTED_TOOL",
      securityDecision: { decision: "SAFE", reason: "allowlisted" },
    });
    const state = await gate.state();
    expect(state.tasks[0]?.status).toBe("in_progress");
    expect(state.events).toHaveLength(0);
  });
});
