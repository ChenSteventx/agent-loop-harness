import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceDependencies, evidenceDependencyHash, operationInputHash } from "../src/bindings.js";
import type { RunBinding } from "../src/domain.js";
import { DatasetCatalog, historicalDataset } from "../src/evaluation/datasets.js";
import { exportRunFacts } from "../src/evaluation/facts.js";
import { createInvocationManifest } from "../src/evaluation/manifests.js";
import { HistoricalReplay } from "../src/evaluation/replay.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

const binding: RunBinding = {
  version: 1,
  taskSpecPath: "/project/task.yaml",
  taskSpec: {
    id: "REPLAY-1",
    goal: "replay immutable facts",
    acceptance: ["the development Run is unchanged"],
    risk: "low",
    verification: [{ id: "test", argv: ["npm", "test"] }],
  },
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
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installCandidate(store: SqliteStore, runId: string, operationId: string): void {
  const operationHash = operationInputHash({ kind: "candidate_commit", commitSha: "candidate" });
  const dependencies = evidenceDependencies({
    commitSha: "candidate",
    taskSpecHash: binding.taskSpecHash,
    acceptanceHash: binding.acceptanceHash,
    policyVersion: binding.policyVersion,
    stepId: "candidate-commit",
    operationInputHash: operationHash,
  });
  store.installEvidence({
    id: `${runId}:candidate`, runId, operationId, kind: "candidate_commit",
    commitSha: "candidate", policyVersion: binding.policyVersion, stepId: "candidate-commit",
    dependencyHash: evidenceDependencyHash(dependencies), dependencies, data: { commitSha: "candidate" },
  });
}

describe("Evaluation Datasets and Historical Replay", () => {
  it("keeps Holdout Tasks inaccessible to proposal generation", () => {
    const catalog = DatasetCatalog.loadDirectory(resolve("eval"));
    expect(catalog.list("comparison").map((dataset) => dataset.kind)).toEqual([
      "failure-injection", "golden", "holdout",
    ]);
    expect(catalog.list("proposal").map((dataset) => dataset.kind)).not.toContain("holdout");
    expect(() => catalog.get("phase3-holdout-v1", "proposal")).toThrow("inaccessible");
  });

  it("blocks full Replay without exact manifests but permits pinned verify-only Replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-replay-"));
    temporaryDirectories.push(directory);
    const development = new SqliteStore(join(directory, "state.sqlite"));
    development.createBoundRun("run-1", binding.taskSpec.id, binding, "2026-07-15T00:00:00.000Z");
    development.createOperation({
      id: "run-1:author", runId: "run-1", kind: "author", idempotencyKey: "run-1:author",
      now: "2026-07-15T00:00:01.000Z",
    });
    development.finishOperation("run-1:author", "succeeded", {}, "2026-07-15T00:00:02.000Z");
    installCandidate(development, "run-1", "run-1:author");
    const facts = exportRunFacts(development, "run-1", { exportedAt: "2026-07-15T00:01:00.000Z" });
    const before = JSON.stringify({
      runs: development.listRuns(), operations: development.listOperations("run-1"),
      evidence: development.listEvidence("run-1"), events: development.listEvents("run-1"),
    });
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evaluation.installFactBundle(facts);
    evaluation.installDataset(historicalDataset("history-v1", [facts]));
    let calls = 0;
    const replay = new HistoricalReplay(evaluation, async () => {
      calls += 1;
      return { passed: true, evidenceHash: "verification-evidence", diagnostics: [] };
    });

    const full = await replay.run({
      id: "evaluation-full", facts, binding, mode: "full", requiredOperationIds: ["run-1:author"],
      createdAt: "2026-07-15T00:02:00.000Z",
    });
    expect(full).toMatchObject({ status: "not-replayable", replayability: "verify-only" });
    expect(full.missingInputs).toContain("exact_replayability");
    expect(calls).toBe(0);

    const verifyOnly = await replay.run({
      id: "evaluation-verify", facts, binding, mode: "verify-only", requiredOperationIds: ["run-1:author"],
      createdAt: "2026-07-15T00:03:00.000Z",
    });
    expect(verifyOnly).toMatchObject({
      status: "completed",
      replayability: "verify-only",
      datasetPartition: "historical",
      championVersion: "development-source",
      challengerVersion: null,
      outcome: { passed: true },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify({
      runs: development.listRuns(), operations: development.listOperations("run-1"),
      evidence: development.listEvidence("run-1"), events: development.listEvents("run-1"),
    })).toBe(before);
    expect(evaluation.listEvaluationRuns()).toHaveLength(2);
    evaluation.close();
    development.close();
  });

  it("allows full Replay only after the source invocation is exactly reproducible", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-exact-replay-"));
    temporaryDirectories.push(directory);
    const development = new SqliteStore(join(directory, "state.sqlite"));
    development.createBoundRun("run-2", binding.taskSpec.id, binding);
    development.createOperation({
      id: "run-2:author", runId: "run-2", kind: "author", idempotencyKey: "run-2:author",
      now: "2026-07-15T00:00:01.000Z",
    });
    development.installInvocationManifest(createInvocationManifest({
      id: "run-2:author:manifest:v1",
      runId: "run-2",
      operationId: "run-2:author",
      role: "author",
      binding,
      renderedPrompt: "bounded author prompt",
      outputSchemaPath: resolve("schemas/author-output.schema.json"),
      configuredProvider: { provider: "Codex CLI", model: "configured-model" },
      actualProvider: {
        provider: "openai-codex", model: "actual-model", modelFamily: "gpt",
        executable: "codex", version: "1.0.0",
      },
      currentCommit: "candidate",
      verificationPlan: binding.taskSpec.verification,
      context: [{ kind: "task", reference: "task.yaml", content: binding.taskSpec, trust: "project" }],
      createdAt: "2026-07-15T00:00:01.000Z",
    }));
    development.finishOperation("run-2:author", "succeeded", {}, "2026-07-15T00:00:02.000Z");
    installCandidate(development, "run-2", "run-2:author");
    const facts = exportRunFacts(development, "run-2");
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evaluation.installFactBundle(facts);
    const replay = new HistoricalReplay(evaluation, async () => ({
      passed: true, evidenceHash: "full-evidence", diagnostics: [],
    }));
    const result = await replay.run({
      id: "evaluation-exact", facts, binding, mode: "full", requiredOperationIds: ["run-2:author"],
    });
    expect(result).toMatchObject({ status: "completed", replayability: "exact", mode: "full" });
    expect(() => evaluation.installEvaluationRun({ ...result, status: "failed" })).toThrow("immutable");
    evaluation.close();
    development.close();
  });
});
