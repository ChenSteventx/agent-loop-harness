import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatasetCatalog } from "../src/evaluation/datasets.js";
import { evaluateReadiness } from "../src/evaluation/readiness.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import {
  assignCanary,
  createCanaryApproval,
  disabledCanaryPolicy,
  policyFromApproval,
  recordCanaryObservation,
  stableCanaryBucket,
} from "../src/evolution/canary.js";
import {
  approveChangeProposal,
  createChangeProposal,
  createChallenger,
  createInitialChampion,
  type EvolutionConfiguration,
} from "../src/evolution/proposals.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

const configuration: EvolutionConfiguration = {
  providerOrder: ["codex"],
  roleModels: { author: "primary" },
  retryLimit: 1,
  timeoutMs: 60_000,
  riskThresholds: { assisted: 1, reviewed: 2 },
  memoryRetrievalEnabled: false,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("disabled low-risk Canary", () => {
  it("uses stable hashing only after Readiness and human approval, then rolls back on a guardrail", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-canary-"));
    temporaryDirectories.push(directory);
    const development = new SqliteStore(join(directory, "state.sqlite"));
    development.createRun("formal-run", "task-1", "2026-07-15T00:00:00.000Z");
    const formalBefore = JSON.stringify({ run: development.getRun("formal-run"), events: development.listEvents("formal-run") });
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const champion = store.installConfigurationVariant(createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration,
      createdAt: "2026-07-15T00:00:00.000Z",
    }));
    const datasets = DatasetCatalog.loadDirectory(resolve("eval")).list("proposal");
    const draft = store.installChangeProposal(createChangeProposal({
      id: "proposal", projectScope: "generic-node", target: "retry-policy", baseChampion: champion,
      patch: { retryLimit: 2 }, rationale: "bounded Canary", sourceFactHashes: ["fact-1", "fact-2"],
      datasets, metrics: ["readySuccessRate"], minimumSamples: 1,
    }));
    const approved = approveChangeProposal(store, { id: draft.id, approvedBy: "human", reason: "evaluate" });
    const challenger = store.installConfigurationVariant(createChallenger({
      id: "challenger", version: "2", proposal: approved, champion,
    }));
    const proposal = store.decideChangeProposal({
      id: approved.id, status: "evaluated", authority: "human", decidedBy: "human", reason: "compare passed",
      decidedAt: "2026-07-15T00:01:00.000Z",
    });
    const comparison = store.installOfflineComparison({
      schemaVersion: 1,
      id: "comparison",
      projectScope: "generic-node",
      proposalId: proposal.id,
      championId: champion.id,
      challengerId: challenger.id,
      datasetIds: datasets.map((dataset) => dataset.id),
      datasetHashes: datasets.map((dataset) => dataset.contentHash),
      holdoutTaskCount: 1,
      evaluatorKind: "full-task-replay",
      evaluatorVersion: "full-task-replay/v1",
      dataSource: "real",
      status: "completed",
      sampleSize: 10,
      champion: { samples: 10, passRate: 1, readyRate: 1, doneRate: 1, verificationFailures: 0, averageLatencyMs: 100 },
      challenger: { samples: 10, passRate: 1, readyRate: 1, doneRate: 1, verificationFailures: 0, averageLatencyMs: 90 },
      deltas: { passRate: 0, readyRate: 0, doneRate: 0, verificationFailures: 0, averageLatencyMs: -10 },
      primaryMetricResult: {
        metric: "readyRate", championValue: 0.9, challengerValue: 1, improvement: 0.1,
        minimumImprovement: 0.01, passed: true,
      },
      guardrailResults: {
        ready: true, done: true, verificationFailures: true, postMergeFailures: null,
        humanEscalation: null, latency: null, tokens: null, cost: null,
      },
      guardrailsSatisfied: true,
      promotionEligible: true,
      promotionBlockers: [],
      resultArtifactHash: "artifact-hash",
      resultHash: "comparison-hash",
      createdAt: "2026-07-15T00:02:00.000Z",
    });
    const approval = store.installCanaryApproval(createCanaryApproval({
      id: "canary-approval",
      projectScope: "generic-node",
      proposal,
      challenger,
      maximumBasisPoints: 500,
      maximumTasks: 5,
      maximumExtraBudgetTokens: 10_000,
      approvedBy: "human-operator",
      reason: "low-risk five-percent cap",
      createdAt: "2026-07-15T00:03:00.000Z",
      expiresAt: "2026-07-16T00:00:00.000Z",
    }));
    const readiness = evaluateReadiness({
      realRunCount: 1,
      resolvedFindingCount: 1,
      completedRealFullTaskReplays: 1,
      goldenTaskCount: 1,
      holdoutTaskCount: 1,
      promotionEligibleRealComparisons: 1,
      completedRealShadowRuns: 1,
      humanCanaryApproval: true,
      coverageComplete: true,
      fixtureOnly: false,
    }, {
      optimizationRealRuns: 1,
      optimizationResolvedFindings: 1,
      optimizationFullTaskReplays: 1,
      optimizationGoldenTasks: 1,
      optimizationHoldoutTasks: 1,
      canaryOfflineComparisons: 1,
      canaryShadowRuns: 1,
    });
    const policy = {
      enabled: true,
      basisPoints: 500,
      hashSalt: "stable-salt",
      projectAllowlist: ["generic-node"],
      maxTasks: 5,
      windowStartsAt: "2026-07-15T00:00:00.000Z",
      windowEndsAt: "2026-07-16T00:00:00.000Z",
      extraBudgetTokens: 5_000,
    };
    let taskKey = "task-0";
    for (let index = 0; stableCanaryBucket("generic-node", taskKey, proposal.id, "stable-salt") >= 500; index += 1) {
      taskKey = `task-${index + 1}`;
    }

    const disabled = assignCanary(store, {
      id: "assignment-disabled", projectScope: "generic-node", taskKey, risk: "low", proposal,
      champion, challenger, comparison, readiness, approval, policy: disabledCanaryPolicy,
      createdAt: "2026-07-15T00:04:00.000Z",
    });
    expect(disabled).toMatchObject({ selected: "champion", basisPoints: 0, reason: "Canary is disabled" });
    const assignment = assignCanary(store, {
      id: "assignment-enabled", projectScope: "generic-node", taskKey, risk: "low", proposal,
      champion, challenger, comparison, readiness, approval,
      policy,
      createdAt: "2026-07-15T00:05:00.000Z",
    });
    expect(assignment).toMatchObject({
      selected: "challenger",
      selectedVariantId: challenger.id,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
    });
    expect(assignment.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stableCanaryBucket("generic-node", taskKey, proposal.id, "stable-salt")).toBe(assignment.bucket);
    expect(policyFromApproval(approval)).toEqual({
      enabled: true,
      basisPoints: approval.maximumBasisPoints,
      hashSalt: "agent-loop-canary-v1",
      projectAllowlist: [approval.projectScope],
      maxTasks: approval.maximumTasks,
      windowStartsAt: approval.createdAt,
      windowEndsAt: approval.expiresAt,
      extraBudgetTokens: approval.maximumExtraBudgetTokens,
    });
    expect(assignCanary(store, {
      id: "assignment-normal", projectScope: "generic-node", taskKey, risk: "normal", proposal,
      champion, challenger, comparison, readiness, approval, policy,
    }).selected).toBe("champion");
    expect(assignCanary(store, {
      id: "assignment-unready", projectScope: "generic-node", taskKey, risk: "low", proposal,
      champion, challenger, comparison, readiness: { ...readiness, canaryReady: false }, approval, policy,
    }).selected).toBe("champion");
    expect(assignCanary(store, {
      id: "assignment-unapproved", projectScope: "generic-node", taskKey, risk: "low", proposal,
      champion, challenger, comparison, readiness, approval: null, policy,
    }).selected).toBe("champion");

    const observation = recordCanaryObservation(store, {
      id: "observation", assignment, formalRunId: "formal-run", factHash: "formal-fact-hash",
      ready: false, done: false, verificationFailures: 1,
      createdAt: "2026-07-15T00:06:00.000Z",
    });
    expect(observation).toMatchObject({ guardrailViolation: true, rollbackDecisionId: "observation:rollback" });
    expect(recordCanaryObservation(store, {
      id: "observation", assignment, formalRunId: "formal-run", factHash: "formal-fact-hash",
      ready: false, done: false, verificationFailures: 1,
      createdAt: "2026-07-15T00:06:00.000Z",
    })).toEqual(observation);
    expect(store.activeChampion("generic-node")?.id).toBe(champion.id);
    expect(store.getConfigurationVariant(challenger.id)?.status).toBe("rolled-back");
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "canary-started"))
      .toMatchObject({ payload: expect.objectContaining({ assignmentId: "assignment-enabled" }) });
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "canary-rolled-back"))
      .toMatchObject({ payload: expect.objectContaining({ formalRunId: "formal-run" }) });
    expect(JSON.stringify({ run: development.getRun("formal-run"), events: development.listEvents("formal-run") }))
      .toBe(formalBefore);
    store.close();
    development.close();
  });

  it("keeps normal-risk tasks and unready or unapproved work on the Champion", () => {
    expect(stableCanaryBucket("scope", "task", "proposal", "salt"))
      .toBe(stableCanaryBucket("scope", "task", "proposal", "salt"));
    expect(disabledCanaryPolicy).toEqual({
      enabled: false,
      basisPoints: 0,
      hashSalt: "agent-loop-canary-v1",
      projectAllowlist: [],
      maxTasks: 0,
      windowStartsAt: "1970-01-01T00:00:00.000Z",
      windowEndsAt: "1970-01-01T00:00:00.000Z",
      extraBudgetTokens: 0,
    });
  });
});
