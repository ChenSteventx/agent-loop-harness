import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptanceHash, taskSpecHash } from "../src/bindings.js";
import type { RunBinding } from "../src/domain.js";
import { createInvocationManifest } from "../src/evaluation/manifests.js";
import { exportRunFacts } from "../src/evaluation/facts.js";
import { FullTaskReplayEvaluator } from "../src/evaluation/evaluators.js";
import { createFullTaskExecutor } from "../src/full-task-executor.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { WorktreeService } from "../src/execution.js";
import { CodexCliAdapter } from "../src/provider.js";
import { GenericNodeProjectAdapter } from "../src/project.js";
import { createInitialChampion, type EvolutionConfiguration } from "../src/evolution/proposals.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
const fakeCodex = resolve("test/fixtures/fake-codex.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function fixtureRepository(checkContent: string): { root: string; baseline: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-full-replay-target-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "replay@example.invalid"]);
  git(root, ["config", "user.name", "Replay Test"]);
  writeFileSync(join(root, "check.mjs"), checkContent);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return { root, baseline: git(root, ["rev-parse", "HEAD"]) };
}

const configuration: EvolutionConfiguration = {
  providerOrder: ["codex"], roleModels: {}, retryLimit: 1, timeoutMs: 60_000,
  contextRanking: ["task", "acceptance", "repository"],
  riskThresholds: { assisted: 1, reviewed: 2 }, memoryRetrievalEnabled: false,
};

function boundFacts(directory: string, repository: { root: string; baseline: string }): {
  binding: RunBinding; facts: ReturnType<typeof exportRunFacts>;
} {
  const binding: RunBinding = {
    version: 1,
    taskSpecPath: join(repository.root, "task.yaml"),
    taskSpec: {
      id: "FULL-REPLAY-1",
      goal: "prove the full-task replay executor",
      acceptance: ["changed.txt is created by the Author"],
      risk: "low",
      verification: [{ id: "replay-check", argv: ["node", "check.mjs"] }],
    },
    taskSpecHash: "",
    acceptanceHash: "",
    baselineCommit: repository.baseline,
    sourceRepository: repository.root,
    worktreePath: join(repository.root, "unused-worktree"),
    risk: "low",
    executionTemplate: "solo",
    providerProfile: "CODEX_PRIMARY",
    projectAdapterName: "generic-node",
    policyVersion: "generic-node/v2",
    configurationVariantId: null, configurationHash: null, canaryAssignmentId: null,
    configSource: "default", runtimeConfiguration: null,
  };
  binding.taskSpecHash = taskSpecHash(binding.taskSpec);
  binding.acceptanceHash = acceptanceHash(binding.taskSpec.acceptance);
  const development = new SqliteStore(join(directory, "state.sqlite"));
  development.createBoundRun("source-run", binding.taskSpec.id, binding);
  development.createOperation({
    id: "source-run:author", runId: "source-run", kind: "author",
    idempotencyKey: "source-run:author", now: "2026-07-17T00:00:01.000Z",
  });
  development.installInvocationManifest(createInvocationManifest({
    id: "source-run:author:manifest:v1",
    runId: "source-run",
    operationId: "source-run:author",
    role: "author",
    binding,
    renderedPrompt: "bounded author prompt",
    outputSchemaPath: resolve("schemas/author-output.schema.json"),
    configuredProvider: { provider: "Codex CLI", model: "configured-model" },
    actualProvider: {
      provider: "openai-codex", model: "actual-model", modelFamily: "gpt",
      executable: "codex", version: "1.0.0",
    },
    currentCommit: repository.baseline,
    verificationPlan: binding.taskSpec.verification,
    context: [{ kind: "task", reference: "task.yaml", content: binding.taskSpec, trust: "project" }],
    createdAt: "2026-07-17T00:00:01.000Z",
  }));
  development.finishOperation("source-run:author", "failed", {}, "2026-07-17T00:00:02.000Z");
  const facts = exportRunFacts(development, "source-run");
  development.close();
  return { binding, facts };
}

function executor() {
  const projectAdapter = new GenericNodeProjectAdapter();
  return createFullTaskExecutor({
    adapters: {
      codex: new CodexCliAdapter({
        sandbox: "workspace-write",
        environment: { ...process.env, CODEX_BIN: fakeCodex, FAKE_CODEX_MODE: "production-author" },
      }),
    },
    defaultFamily: "codex",
    verificationCommands: (task) => projectAdapter.verificationCommands(task),
  });
}

describe("full-task replay execution", () => {
  it("re-executes a failed historical task in an isolated worktree and passes verification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-full-replay-home-"));
    temporaryDirectories.push(directory);
    const repository = fixtureRepository(
      "import { readFileSync } from 'node:fs'; process.exit(readFileSync('changed.txt', 'utf8').includes('production CLI') ? 0 : 5);\n",
    );
    const { binding, facts } = boundFacts(directory, repository);
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evaluation.installFactBundle(facts);
    const champion = createInitialChampion({
      id: "replay-champion", projectScope: "generic-node", version: "1", configuration,
    });
    const evaluator = new FullTaskReplayEvaluator(
      evaluation,
      new WorktreeService(repository.root),
      executor(),
      join(directory, "evaluation"),
    );
    const run = await evaluator.evaluate({
      id: "full-replay-pass", facts, binding, configurationVariant: champion,
    });
    expect(run).toMatchObject({
      status: "completed",
      mode: "full",
      evaluatorKind: "full-task-replay",
      replayability: "manifest-complete",
      outcome: { passed: true },
    });
    expect(run.outcome?.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(git(repository.root, ["rev-parse", "HEAD"])).toBe(repository.baseline);
    expect(git(repository.root, ["worktree", "list"]).split("\n")).toHaveLength(1);
    evaluation.close();
  }, 120_000);

  it("reports a failing verification honestly and still cleans up the worktree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-full-replay-fail-home-"));
    temporaryDirectories.push(directory);
    const repository = fixtureRepository(
      "process.exit(7);\n",
    );
    const { binding, facts } = boundFacts(directory, repository);
    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evaluation.installFactBundle(facts);
    const champion = createInitialChampion({
      id: "replay-champion-fail", projectScope: "generic-node", version: "1", configuration,
    });
    const evaluator = new FullTaskReplayEvaluator(
      evaluation,
      new WorktreeService(repository.root),
      executor(),
      join(directory, "evaluation"),
    );
    const run = await evaluator.evaluate({
      id: "full-replay-fail", facts, binding, configurationVariant: champion,
    });
    expect(run).toMatchObject({ status: "completed", outcome: { passed: false } });
    expect(run.outcome?.diagnostics).toContain("replay-check");
    expect(git(repository.root, ["worktree", "list"]).split("\n")).toHaveLength(1);
    evaluation.close();
  }, 120_000);
});
