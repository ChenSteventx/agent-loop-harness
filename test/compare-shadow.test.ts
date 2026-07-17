import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operationInputHash } from "../src/bindings.js";
import type { RunBinding } from "../src/domain.js";
import { compareVariants, runShadowEvaluation } from "../src/evaluation/compare.js";
import { DatasetCatalog } from "../src/evaluation/datasets.js";
import { exportRunFacts } from "../src/evaluation/facts.js";
import { EvaluationStore } from "../src/evaluation/store.js";
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
  providerOrder: ["codex", "claude"],
  roleModels: { author: "primary" },
  retryLimit: 1,
  timeoutMs: 60_000,
  riskThresholds: { assisted: 1, reviewed: 2 },
  memoryRetrievalEnabled: false,
};

const binding: RunBinding = {
  version: 1,
  taskSpecPath: "/project/task.yaml",
  taskSpec: { id: "SHADOW-1", goal: "stay authoritative", acceptance: ["state unchanged"], risk: "low",
    verification: [{ id: "test", argv: ["npm", "test"] }] },
  taskSpecHash: "task-hash",
  acceptanceHash: "acceptance-hash",
  baselineCommit: "baseline",
  sourceRepository: "/project",
  worktreePath: "/project-worktree",
  risk: "low",
  executionTemplate: "solo",
  providerProfile: "CODEX_PRIMARY",
  projectAdapterName: "generic-node",
  policyVersion: "generic-node/v2",
  configurationVariantId: null, configurationHash: null, canaryAssignmentId: null,
  configSource: "default", runtimeConfiguration: null,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("offline comparison and non-authoritative Shadow", () => {
  it("compares Champion and Challenger with Holdout while leaving the formal Run unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-compare-"));
    temporaryDirectories.push(directory);
    const development = new SqliteStore(join(directory, "state.sqlite"));
    development.createBoundRun("run-1", binding.taskSpec.id, binding, "2026-07-15T00:00:00.000Z");
    const facts = exportRunFacts(development, "run-1", { exportedAt: "2026-07-15T00:01:00.000Z" });
    const before = JSON.stringify({ run: development.getRun("run-1"), events: development.listEvents("run-1") });
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evaluation.installFactBundle(facts);
    const champion = evaluation.installConfigurationVariant(createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration,
      createdAt: "2026-07-15T00:00:00.000Z",
    }));
    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    const proposal = evaluation.installChangeProposal(createChangeProposal({
      id: "proposal", projectScope: "generic-node", target: "retry-policy", baseChampion: champion,
      patch: { retryLimit: 2 }, rationale: "bounded transient recovery", sourceFactHashes: ["fact-1", "fact-2"],
      datasets: catalog.list("proposal"), metrics: ["readySuccessRate", "doneSuccessRate"], minimumSamples: 2,
    }));
    const approved = approveChangeProposal(evaluation, {
      id: proposal.id, approvedBy: "human", reason: "evaluate only",
    });
    const challenger = evaluation.installConfigurationVariant(createChallenger({
      id: "challenger", version: "2", proposal: approved, champion,
    }));
    const datasets = catalog.list("comparison");
    const comparison = await compareVariants(evaluation, {
      id: "comparison",
      proposal: approved,
      champion,
      challenger,
      datasets,
      evaluatorKind: "verify-only",
      evaluatorVersion: "verify-only/v1",
      evaluate: async (variant, task) => ({
        passed: true,
        ready: true,
        done: task.expected.done ?? false,
        verificationFailures: 0,
        latencyMs: variant.status === "champion" ? 100 : 90,
        resultHash: operationInputHash({ variant: variant.id, task: task.id }),
      }),
      createdAt: "2026-07-15T00:02:00.000Z",
    });
    expect(comparison).toMatchObject({
      status: "completed", guardrailsSatisfied: true, sampleSize: 3, holdoutTaskCount: 1,
      deltas: { readyRate: 0, doneRate: 0, verificationFailures: 0, averageLatencyMs: -10 },
    });

    const shadow = await runShadowEvaluation(evaluation, {
      id: "shadow",
      facts,
      champion,
      challenger,
      advise: async (variant) => ({
        contextReferences: ["task", "acceptance"],
        providerRoute: variant.configuration.providerOrder[0]!,
        executionTemplate: "solo",
        requireReview: false,
        approvedMemoryIds: [],
        timeoutMs: variant.configuration.timeoutMs,
        retryLimit: variant.configuration.retryLimit,
      }),
      createdAt: "2026-07-15T00:03:00.000Z",
    });
    expect(shadow).toMatchObject({
      authoritative: false, providerRoutingChanged: false, runStateChanged: false, agrees: false,
      dataSource: "real",
      differences: [expect.objectContaining({ field: "retryLimit", champion: 1, challenger: 2 })],
    });
    expect(evaluation.activeChampion("generic-node")?.id).toBe(champion.id);
    expect(JSON.stringify({ run: development.getRun("run-1"), events: development.listEvents("run-1") })).toBe(before);
    expect(evaluation.listOfflineComparisons()).toEqual([comparison]);
    expect(evaluation.listShadowEvaluations()).toEqual([shadow]);
    const legacyShadow = { ...shadow, id: "legacy-shadow" } as { dataSource?: string };
    delete legacyShadow.dataSource;
    evaluation.database.prepare(
      `INSERT INTO shadow_evaluations
       (id, source_run_id, source_fact_hash, project_scope, champion_id, challenger_id, agrees, shadow_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy-shadow", shadow.sourceRunId, shadow.sourceFactHash, shadow.projectScope,
      shadow.championId, shadow.challengerId, 0, JSON.stringify(legacyShadow), shadow.createdAt);
    expect(evaluation.listShadowEvaluations().find((row) => row.id === "legacy-shadow")?.dataSource)
      .toBe("fixture");
    expect(evaluation.listPendingEvolutionOutbox().find((event) => event.type === "shadow-ready"))
      .toMatchObject({ payload: expect.objectContaining({ shadowId: shadow.id, sourceRunId: "run-1" }) });
    evaluation.close();
    development.close();
  });

  it("fails closed when the Challenger violates a zero-regression guardrail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-compare-guard-"));
    temporaryDirectories.push(directory);
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const champion = evaluation.installConfigurationVariant(createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration,
    }));
    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    const proposal = evaluation.installChangeProposal(createChangeProposal({
      id: "proposal", projectScope: "generic-node", target: "timeout-policy", baseChampion: champion,
      patch: { timeoutMs: 90_000 }, rationale: "bounded timeout study", sourceFactHashes: ["fact"],
      datasets: catalog.list("proposal"), metrics: ["readySuccessRate"], minimumSamples: 1,
    }));
    const approved = approveChangeProposal(evaluation, { id: proposal.id, approvedBy: "human", reason: "evaluate" });
    const challenger = evaluation.installConfigurationVariant(createChallenger({
      id: "challenger", version: "2", proposal: approved, champion,
    }));
    const comparison = await compareVariants(evaluation, {
      id: "comparison-failed", proposal: approved, champion, challenger,
      datasets: catalog.list("proposal"),
      evaluatorKind: "verify-only",
      evaluatorVersion: "verify-only/v1",
      evaluate: async (variant, task) => ({
        passed: variant.status === "champion",
        ready: variant.status === "champion",
        done: false,
        verificationFailures: variant.status === "champion" ? 0 : 1,
        latencyMs: 100,
        resultHash: operationInputHash({ variant: variant.id, task: task.id }),
      }),
    });
    expect(comparison).toMatchObject({ status: "guardrail-failed", guardrailsSatisfied: false });
    expect(evaluation.activeChampion("generic-node")?.id).toBe(champion.id);
    evaluation.close();
  });

  it("does not allow Verify-only to evaluate Provider Routing strategy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-compare-verify-only-"));
    temporaryDirectories.push(directory);
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const champion = evaluation.installConfigurationVariant(createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration,
    }));
    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    const proposal = evaluation.installChangeProposal(createChangeProposal({
      id: "provider-proposal", projectScope: "generic-node", target: "provider-routing", baseChampion: champion,
      patch: { providerOrder: ["claude", "codex"] }, rationale: "bounded routing study",
      sourceFactHashes: ["fact-1", "fact-2"], datasets: catalog.list("proposal"),
      metrics: ["readyRate"], minimumSamples: 1,
    }));
    const approved = approveChangeProposal(evaluation, {
      id: proposal.id, approvedBy: "human", reason: "verify evaluator boundary",
    });
    const challenger = evaluation.installConfigurationVariant(createChallenger({
      id: "challenger", version: "2", proposal: approved, champion,
    }));
    await expect(compareVariants(evaluation, {
      id: "forbidden-comparison", proposal: approved, champion, challenger,
      datasets: catalog.list("comparison"), evaluatorKind: "verify-only", evaluatorVersion: "verify-only/v1",
      evaluate: async () => ({
        passed: true, ready: true, done: false, verificationFailures: 0, latencyMs: 1, resultHash: "unused",
      }),
    })).rejects.toThrow("Verify-only evaluator cannot evaluate");
    // createChangeProposal now rejects memory-retrieval outright (not runtime
    // wired), so exercise the compare-layer gate on a hand-built proposal: the
    // "memory-retrieval-proposal" defence must hold even if the factory gate
    // is bypassed.
    const memoryProposal = { ...approved, target: "memory-retrieval" as const };
    await expect(compareVariants(evaluation, {
      id: "forbidden-memory-comparison", proposal: memoryProposal, champion, challenger,
      datasets: catalog.list("comparison"), evaluatorKind: "verify-only", evaluatorVersion: "verify-only/v1",
      evaluate: async () => ({
        passed: true, ready: true, done: false, verificationFailures: 0, latencyMs: 1, resultHash: "unused",
      }),
    })).rejects.toThrow("Verify-only evaluator cannot evaluate memory-retrieval");
    expect(evaluation.listOfflineComparisons()).toEqual([]);
    evaluation.close();
  });
});
