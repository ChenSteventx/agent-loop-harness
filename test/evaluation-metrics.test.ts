import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationFactSource, exportRunFacts } from "../src/evaluation/facts.js";
import { projectRunMetrics, summarizeMetrics } from "../src/evaluation/metrics.js";
import { evaluateReadiness } from "../src/evaluation/readiness.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sanitized fact projections", () => {
  it("projects metrics from durable facts without treating Reviewer assertions as truth", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-evaluation-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.sqlite");
    const store = new SqliteStore(statePath);
    store.createRun("run-1", "task-1", "2026-07-15T00:00:00.000Z");
    store.createOperation({
      id: "review-1",
      runId: "run-1",
      kind: "reviewer",
      idempotencyKey: "review-1",
      input: { raw: "SECRET INPUT" },
      now: "2026-07-15T00:00:01.000Z",
    });
    store.finishOperation("review-1", "succeeded", {
      report: {
        findings: [{ id: "F-1", category: "correctness", severity: "high", claim: "SECRET REVIEW CLAIM" }],
      },
    }, "2026-07-15T00:00:02.000Z");
    store.createOperation({
      id: "repair-1", runId: "run-1", kind: "repair", idempotencyKey: "repair-1",
      now: "2026-07-15T00:00:03.000Z",
    });
    store.finishOperation("repair-1", "succeeded", {}, "2026-07-15T00:00:04.000Z");
    store.installEvidence({
      id: "finding-1", runId: "run-1", operationId: "review-1", kind: "finding_validation",
      commitSha: "candidate", policyVersion: "policy", stepId: "finding-validation:F-1",
      dependencyHash: "finding-dependency", data: { findingId: "F-1", status: "inconclusive", reason: "SECRET" },
      now: "2026-07-15T00:00:05.000Z",
    });
    store.installEvidence({
      id: "verify-failure", runId: "run-1", operationId: null, kind: "verification_failure",
      commitSha: "candidate", policyVersion: "policy", stepId: "verify:test",
      dependencyHash: "failure-dependency", data: { stderr: "SECRET STDERR" },
      now: "2026-07-15T00:00:06.000Z",
    });
    store.recordAgentCall("run-1", {
      role: "reviewer", provider: "test-provider", latencyMs: 250,
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
    }, "2026-07-15T00:00:07.000Z");
    store.appendEvent("run-1", "provider.failure", { failureClass: "quota", stderr: "SECRET PROVIDER" });
    store.appendEvent("run-1", "provider.fallback", { reason: "quota" });
    const inbox = store.createHumanInbox("run-1", {
      question: "SECRET QUESTION", options: ["confirm", "reject"], recommendation: "inspect",
      evidence: { secret: true }, risk: "wrong metric", consequence: "bad promotion", resumeCommand: "resume",
    });
    store.resolveHumanInbox(inbox.id, {
      type: "finding", findingId: "F-1", outcome: "rejected", note: "SECRET HUMAN NOTE",
    }, "2026-07-15T00:00:08.000Z");
    store.transitionRun("run-1", "ready", { now: "2026-07-15T00:00:09.000Z" });
    store.transitionRun("run-1", "merged", { now: "2026-07-15T00:00:10.000Z", mergeSha: "merge" });
    store.transitionRun("run-1", "done", { now: "2026-07-15T00:00:11.000Z" });
    const eventCount = store.listEvents("run-1").length;

    const facts = exportRunFacts(store, "run-1", { exportedAt: "2026-07-15T00:01:00.000Z" });
    const factSource = new EvaluationFactSource(store);
    expect(factSource.exportRun("run-1", { exportedAt: "2026-07-15T00:01:00.000Z" })).toEqual(facts);
    expect(factSource.listEligibleRuns({ statuses: ["done"], requireBinding: false },
      { exportedAt: "2026-07-15T00:01:00.000Z" })).toEqual([facts]);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("SECRET");
    expect(store.listEvents("run-1")).toHaveLength(eventCount);
    expect(facts.reviewerFindings).toEqual([{
      id: "F-1", category: "correctness", severity: "high", outcome: "rejected", authority: "human",
    }]);

    const metrics = projectRunMetrics(facts);
    expect(metrics).toMatchObject({
      readySuccess: true,
      doneSuccess: true,
      firstPassSuccess: false,
      fixPasses: 1,
      agentCalls: 1,
      costUsd: null,
      verificationFailures: 1,
      reviewerFindings: { confirmed: 0, rejected: 1, inconclusive: 0 },
      reviewPrecision: 0,
      reviewRecall: "unknown",
      providerFallbacks: 1,
      quotaFailures: 1,
    });
    expect(summarizeMetrics([metrics])).toMatchObject({
      readySuccessRate: 1, doneSuccessRate: 1, firstPassSuccessRate: 0, costUsd: null,
    });

    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    expect(evaluation.installFactBundle(facts)).toEqual(facts);
    evaluation.installMetrics(metrics, facts.factHash);
    expect(evaluation.getMetrics("run-1", facts.factHash)).toEqual(metrics);
    expect(() => evaluation.installFactBundle({ ...facts, run: { ...facts.run, status: "failed" } }))
      .toThrow("immutable");
    evaluation.close();
    store.close();
  });

  it("keeps optimization and Canary readiness disabled when real evidence is insufficient", () => {
    const report = evaluateReadiness({
      realRunCount: 0,
      resolvedFindingCount: 0,
      manifestCompleteReplayCount: 0,
      goldenTaskCount: 0,
      holdoutTaskCount: 0,
      completedOfflineComparisons: 0,
      completedShadowRuns: 0,
      humanCanaryApproval: false,
      coverageComplete: false,
      fixtureOnly: true,
    });
    expect(report.mechanismReady).toBe(true);
    expect(report.offlineCompareReady).toBe(false);
    expect(report.shadowReady).toBe(false);
    expect(report.optimizationReady).toBe(false);
    expect(report.canaryReady).toBe(false);
    expect(report.optimizationBlockers).toEqual(expect.arrayContaining([
      expect.stringContaining("real development runs"),
      expect.stringContaining("Holdout Tasks"),
    ]));
    expect(report.canaryBlockers).toContain("human Canary approval is missing");
  });
});
