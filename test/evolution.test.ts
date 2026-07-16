import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operationInputHash } from "../src/bindings.js";
import { compareVariants } from "../src/evaluation/compare.js";
import { DatasetCatalog, type EvaluationDataset } from "../src/evaluation/datasets.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import {
  approveChangeProposal,
  createChangeProposal,
  createChallenger,
  createInitialChampion,
  evolutionTargets,
  promoteChallenger,
  rollbackChampion,
  type EvolutionConfiguration,
  type EvolutionTarget,
} from "../src/evolution/proposals.js";

const temporaryDirectories: string[] = [];

const configuration: EvolutionConfiguration = {
  providerOrder: ["codex", "claude"],
  roleModels: { author: "primary", reviewer: "independent" },
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

describe("controlled Champion and Challenger evolution", () => {
  it("allows only a persisted eligible Comparison to promote and deterministically roll back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-evolution-"));
    temporaryDirectories.push(directory);
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const champion = createInitialChampion({
      id: "champion-v1", projectScope: "generic-node", version: "1", configuration,
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    store.installConfigurationVariant(champion);
    expect(() => store.installConfigurationVariant({ ...champion, id: "another-champion" }))
      .toThrow("already has an active Champion");

    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    const datasets = catalog.list("proposal").map(asRealDataset);
    const proposal = createChangeProposal({
      id: "proposal-retry-v2",
      projectScope: "generic-node",
      target: "retry-policy",
      baseChampion: champion,
      patch: { retryLimit: 2 },
      rationale: "Two real transient failures recovered on the second attempt",
      sourceFactHashes: ["fact-1", "fact-2"],
      datasets,
      metrics: ["readySuccessRate", "verificationFailures"],
      minimumSamples: 2,
      createdAt: "2026-07-15T00:01:00.000Z",
    });
    store.installChangeProposal(proposal);
    const approved = approveChangeProposal(store, {
      id: proposal.id,
      approvedBy: "human-reviewer",
      reason: "bounded configuration-only experiment",
      decidedAt: "2026-07-15T00:02:00.000Z",
    });
    const challenger = createChallenger({
      id: "challenger-v2", version: "2", proposal: approved, champion,
      createdAt: "2026-07-15T00:03:00.000Z",
    });
    store.installConfigurationVariant(challenger);
    const comparison = await compareVariants(store, {
      id: "compare-v2",
      proposal: approved,
      champion,
      challenger,
      datasets: catalog.list("comparison").map(asRealDataset),
      evaluatorKind: "full-task-replay",
      evaluatorVersion: "full-task-replay/v1",
      evaluate: async (variant, task) => ({
        passed: variant.id === challenger.id,
        ready: variant.id === challenger.id,
        done: false,
        verificationFailures: 0,
        latencyMs: variant.id === challenger.id ? 90 : 100,
        resultHash: operationInputHash({ variant: variant.id, task: task.id }),
      }),
      createdAt: "2026-07-15T00:04:00.000Z",
    });
    store.decideChangeProposal({
      id: proposal.id,
      status: "evaluated",
      authority: "human",
      decidedBy: "human-reviewer",
      reason: "offline comparison completed",
      decidedAt: "2026-07-15T00:04:00.000Z",
    });
    expect(() => promoteChallenger(store, {
      id: "missing-promotion", comparisonId: "missing", decidedBy: "human-reviewer", reason: "forged",
    })).toThrow("not found");
    for (const forged of [
      { ...comparison, id: "fixture-comparison", dataSource: "fixture" as const },
      { ...comparison, id: "no-holdout-comparison", holdoutTaskCount: 0 },
      { ...comparison, id: "no-improvement-comparison",
        primaryMetricResult: { ...comparison.primaryMetricResult, improvement: 0, passed: false } },
    ]) {
      store.installOfflineComparison(forged);
      expect(() => promoteChallenger(store, {
        id: `promotion:${forged.id}`, comparisonId: forged.id,
        decidedBy: "human-reviewer", reason: "forged comparison must fail",
      })).toThrow("not eligible");
    }
    const promoted = promoteChallenger(store, {
      id: "promotion-v2",
      comparisonId: "compare-v2",
      decidedBy: "human-reviewer",
      reason: "all guardrails passed",
      decidedAt: "2026-07-15T00:05:00.000Z",
    });
    expect(promoted).toMatchObject({ id: challenger.id, status: "champion", configuration: { retryLimit: 2 } });
    expect(store.listConfigurationVariants("generic-node").filter((item) => item.status === "champion"))
      .toEqual([expect.objectContaining({ id: challenger.id })]);
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "proposal-created"))
      .toMatchObject({ payload: expect.objectContaining({ proposalId: proposal.id }) });
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "canary-promoted"))
      .toMatchObject({ payload: expect.objectContaining({ championId: challenger.id }) });

    const restored = rollbackChampion(store, {
      id: "rollback-v2",
      projectScope: "generic-node",
      fromChampionId: challenger.id,
      restoreChampionId: champion.id,
      reason: "post-activation verification failure guardrail",
      triggerEvidenceHash: "guardrail-evidence",
      authority: "automatic-guardrail",
      decidedBy: "evolution-guardrail",
      decidedAt: "2026-07-15T00:06:00.000Z",
    });
    expect(restored).toMatchObject({ id: champion.id, status: "champion", configuration: { retryLimit: 1 } });
    expect(store.getConfigurationVariant(challenger.id)?.status).toBe("rolled-back");
    expect(store.getChangeProposal(proposal.id)?.status).toBe("rolled-back");
    store.close();
  });

  it("rejects Holdout access, arbitrary targets, cross-target patches, and premature promotion", () => {
    expect(evolutionTargets).not.toContain("risk-thresholds");
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-evolution-guard-"));
    temporaryDirectories.push(directory);
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const champion = store.installConfigurationVariant(createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration,
    }));
    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    const base = {
      id: "proposal",
      projectScope: "generic-node",
      baseChampion: champion,
      rationale: "bounded evidence",
      sourceFactHashes: ["fact-1"],
      metrics: ["readySuccessRate"],
      minimumSamples: 2,
    };
    expect(() => createChangeProposal({
      ...base,
      target: "source-code" as EvolutionTarget,
      patch: { retryLimit: 2 },
      datasets: catalog.list("proposal"),
    })).toThrow("Forbidden evolution target");
    expect(() => createChangeProposal({
      ...base,
      target: "retry-policy",
      patch: { timeoutMs: 90_000 },
      datasets: catalog.list("proposal"),
    })).toThrow("exceeds allowed target");
    expect(() => createChangeProposal({
      ...base,
      target: "retry-policy",
      patch: { retryLimit: 2 },
      datasets: [catalog.get("phase3-holdout-v1", "comparison")],
    })).toThrow("cannot access Holdout");
    store.close();
  });
});

function asRealDataset(dataset: EvaluationDataset): EvaluationDataset {
  const document = {
    schemaVersion: 1 as const,
    id: dataset.id,
    kind: dataset.kind,
    dataSource: "real" as const,
    version: dataset.version,
    tasks: dataset.tasks,
  };
  return { ...document, contentHash: operationInputHash(document) };
}
