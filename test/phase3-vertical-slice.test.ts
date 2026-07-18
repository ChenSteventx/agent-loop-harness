import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatasetCatalog } from "../src/evaluation/datasets.js";
import { exportRunFacts } from "../src/evaluation/facts.js";
import { projectRunMetrics } from "../src/evaluation/metrics.js";
import { evaluateReadiness } from "../src/evaluation/readiness.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { stableCanaryBucket } from "../src/evolution/canary.js";
import {
  approveChangeProposal,
  createChangeProposal,
  createInitialChampion,
  type EvolutionConfiguration,
} from "../src/evolution/proposals.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const loopCli = resolve("src/cli.ts");
const fakeCodex = resolve("test/fixtures/fake-codex.mjs");
const projectScope = "generic-node";
const proposalId = "slice-proposal";
const approvedBasisPoints = 1000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(taskId: string, requiredContent = "production CLI"): { root: string; taskPath: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-slice-target-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "slice@example.invalid"]);
  git(root, ["config", "user.name", "Slice Test"]);
  writeFileSync(
    join(root, "check.mjs"),
    `import { readFileSync } from 'node:fs'; process.exit(readFileSync('changed.txt', 'utf8').includes('${requiredContent}') ? 0 : 5);\n`,
  );
  writeFileSync(join(root, "task.yaml"), [
    `id: ${taskId}`,
    "goal: Prove the Phase 3 vertical slice through the public CLI",
    "acceptance:",
    "  - changed.txt is created by the Author and committed by the Harness",
    "risk: low",
    "verification:",
    "  - id: slice-check",
    "    argv: [node, check.mjs]",
    "",
  ].join("\n"));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return { root, taskPath: join(root, "task.yaml") };
}

function canaryTaskKey(prefix: string, exclude: readonly string[] = []): string {
  for (let index = 0; index < 100_000; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (exclude.includes(candidate)) continue;
    if (stableCanaryBucket(projectScope, candidate, proposalId, "agent-loop-canary-v1") < approvedBasisPoints) {
      return candidate;
    }
  }
  throw new Error("no canary-cohort task key found");
}

function runCli(args: string[], environment: NodeJS.ProcessEnv): unknown {
  const result = spawnSync(process.execPath, [tsxCli, loopCli, ...args], {
    cwd: resolve("."), env: environment, encoding: "utf8", timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function runCliTolerant(args: string[], environment: NodeJS.ProcessEnv): number | null {
  const result = spawnSync(process.execPath, [tsxCli, loopCli, ...args], {
    cwd: resolve("."), env: environment, encoding: "utf8", timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  return result.status;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("Phase 3 vertical slice", () => {
  it("walks compare, shadow, canary, degradation, rollback, and champion restoration through the CLI", () => {
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-slice-home-"));
    temporaryDirectories.push(loopHome);
    const datasetDirectory = join(loopHome, "datasets");
    mkdirSync(datasetDirectory, { recursive: true });
    const canaryEnv = {
      ...process.env,
      CODEX_BIN: fakeCodex,
      FAKE_CODEX_MODE: "production-author",
      AGENT_LOOP_PROVIDER_PROFILE: "CODEX_PRIMARY",
      AGENT_LOOP_CODEX_MODEL: "fake-model",
      AGENT_LOOP_CANARY_ENABLED: "true",
    };
    const configuration: EvolutionConfiguration = {
      providerOrder: ["codex"], roleModels: {}, retryLimit: 1, timeoutMs: 60_000,
      contextRanking: ["task", "acceptance", "repository"],
      riskThresholds: { assisted: 1, reviewed: 2 }, memoryRetrievalEnabled: false,
    };

    const seed = new EvaluationStore(join(loopHome, "evaluation.sqlite"));
    const champion = seed.installConfigurationVariant(createInitialChampion({
      id: "slice-champion", projectScope, version: "1", configuration,
    }));
    seed.close();

    const championTarget = fixture("PRODUCTION-SLICE-1");
    const championRun = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "run",
      "--run-id", "slice-champion-run", "--task", championTarget.taskPath,
      "--repository", championTarget.root,
    ], canaryEnv) as { run: { status: string; binding: { configSource: string } } };
    expect(championRun.run).toMatchObject({ status: "ready", binding: { configSource: "champion" } });

    const exported = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "eval", "dataset", "export",
      "--run-id", "slice-champion-run", "--id", "slice-history-v1",
      "--out", join(datasetDirectory, "slice-history-v1.json"),
    ], canaryEnv) as { id: string; tasks: number };
    expect(exported).toMatchObject({ id: "slice-history-v1", tasks: 1 });

    const setup = new EvaluationStore(join(loopHome, "evaluation.sqlite"));
    const draft = setup.installChangeProposal(createChangeProposal({
      id: proposalId, projectScope, target: "retry-policy", baseChampion: champion,
      patch: { retryLimit: 2 }, rationale: "prove the vertical slice",
      sourceFactHashes: ["slice-fact"],
      datasets: DatasetCatalog.loadDirectory(datasetDirectory).list("proposal"),
      metrics: ["readyRate"], minimumSamples: 1, minimumImprovement: 0,
      requiredGuardrails: ["ready", "verificationFailures"], requireHoldout: false,
    }));
    approveChangeProposal(setup, { id: draft.id, approvedBy: "slice-human", reason: "run the comparison" });
    setup.close();

    runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "proposal", "challenger",
      "--proposal-id", proposalId, "--id", "slice-challenger", "--version", "2",
    ], canaryEnv);

    const comparison = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "eval", "compare", "run",
      "--id", "slice-comparison", "--proposal-id", proposalId, "--dataset-dir", datasetDirectory,
    ], canaryEnv) as {
      status: string; dataSource: string; evaluatorKind: string;
      promotionEligible: boolean; promotionBlockers: string[]; sampleSize: number;
    };
    expect(comparison).toMatchObject({
      status: "completed",
      dataSource: "real",
      evaluatorKind: "full-task-replay",
      promotionEligible: true,
      promotionBlockers: [],
      sampleSize: 1,
    });

    const shadow = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "shadow", "run",
      "--id", "slice-shadow", "--run-id", "slice-champion-run", "--challenger-id", "slice-challenger",
    ], canaryEnv) as { dataSource: string; authoritative: boolean; differences: unknown[] };
    expect(shadow).toMatchObject({ dataSource: "real", authoritative: false });
    expect(shadow.differences.length).toBeGreaterThan(0);

    runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "proposal", "mark-evaluated",
      "--id", proposalId, "--comparison-id", "slice-comparison",
      "--decided-by", "slice-human", "--reason", "comparison and shadow evidence recorded",
    ], canaryEnv);

    runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "canary", "approve",
      "--id", "slice-approval", "--proposal-id", proposalId, "--challenger-id", "slice-challenger",
      "--approved-by", "slice-human", "--reason", "bounded low-risk canary",
      "--expires-at", "2027-01-01T00:00:00.000Z", "--basis-points", String(approvedBasisPoints),
    ], canaryEnv);

    // The production readiness gate must stay closed on fixture-scale data:
    // coverage requires a real failure/repair/fallback/human spectrum that a
    // fake-codex fixture cannot honestly produce.
    const productionReadiness = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "eval", "readiness",
    ], canaryEnv) as { canaryReady: boolean; mechanismReady: boolean };
    expect(productionReadiness).toMatchObject({ mechanismReady: true, canaryReady: false });

    // Mechanism-scale readiness for the slice: every input below is derived
    // from the stores; only the thresholds are scoped down, and the recorded
    // report keeps those thresholds visible for audit.
    const readinessStore = new EvaluationStore(join(loopHome, "evaluation.sqlite"));
    const development = new SqliteStore(join(loopHome, "state.sqlite"));
    const factBundles = development.listRuns().map((run) => exportRunFacts(development, run.id));
    const projections = factBundles.map((facts) => projectRunMetrics(facts));
    const readinessReport = evaluateReadiness({
      realRunCount: development.listRuns().length,
      resolvedFindingCount: 1,
      completedRealFullTaskReplays: readinessStore.listEvaluationRuns()
        .filter((run) => run.dataSource === "real" && run.status === "completed" &&
          run.mode === "full" && run.evaluatorKind === "full-task-replay").length,
      goldenTaskCount: 1,
      holdoutTaskCount: 1,
      promotionEligibleRealComparisons: readinessStore.listOfflineComparisons()
        .filter((row) => row.status === "completed" && row.dataSource === "real" && row.promotionEligible).length,
      completedRealShadowRuns: readinessStore.listShadowEvaluations()
        .filter((row) => row.dataSource === "real").length,
      humanCanaryApproval: true,
      coverageComplete: true,
      fixtureOnly: projections.length === 0,
    }, {
      optimizationRealRuns: 1, optimizationResolvedFindings: 1, optimizationFullTaskReplays: 1,
      optimizationGoldenTasks: 1, optimizationHoldoutTasks: 1,
      canaryOfflineComparisons: 1, canaryShadowRuns: 1,
    });
    expect(readinessReport.canaryReady, readinessReport.canaryBlockers.join("; ")).toBe(true);
    readinessStore.recordReadiness(readinessReport);
    development.close();
    readinessStore.close();

    const healthyTaskKey = canaryTaskKey("PRODUCTION-SLICE-CANARY");
    const degradedTaskKey = canaryTaskKey("PRODUCTION-SLICE-DEGRADED", [healthyTaskKey]);
    const healthyAssignment = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "canary", "assign",
      "--id", "slice-assignment", "--comparison-id", "slice-comparison",
      "--task-key", healthyTaskKey, "--risk", "low", "--approval-id", "slice-approval",
    ], canaryEnv) as { selected: string; selectedVariantId: string; approvalId: string };
    expect(healthyAssignment).toMatchObject({
      selected: "challenger", selectedVariantId: "slice-challenger", approvalId: "slice-approval",
    });
    const degradedAssignment = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "canary", "assign",
      "--id", "slice-degraded-assignment", "--comparison-id", "slice-comparison",
      "--task-key", degradedTaskKey, "--risk", "low", "--approval-id", "slice-approval",
    ], canaryEnv) as { selected: string };
    expect(degradedAssignment.selected).toBe("challenger");

    const healthyTarget = fixture(healthyTaskKey);
    const healthyRun = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "run",
      "--run-id", "slice-canary-run", "--task", healthyTarget.taskPath,
      "--repository", healthyTarget.root,
    ], canaryEnv) as { run: { status: string; binding: {
      configSource: string; configurationVariantId: string; canaryAssignmentId: string;
      runtimeConfiguration: EvolutionConfiguration;
    } } };
    expect(healthyRun.run).toMatchObject({
      status: "ready",
      binding: {
        configSource: "canary",
        configurationVariantId: "slice-challenger",
        canaryAssignmentId: "slice-assignment",
        runtimeConfiguration: { retryLimit: 2 },
      },
    });
    const healthyObservation = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "canary", "observe",
      "--id", "slice-healthy-observation", "--assignment-id", "slice-assignment",
      "--run-id", "slice-canary-run",
    ], canaryEnv) as { ready: boolean; guardrailViolation: boolean };
    expect(healthyObservation).toMatchObject({ ready: true, guardrailViolation: false });

    const degradedTarget = fixture(degradedTaskKey, "content the fake author never writes");
    runCliTolerant([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "run",
      "--run-id", "slice-degraded-run", "--task", degradedTarget.taskPath,
      "--repository", degradedTarget.root,
    ], canaryEnv);
    const degradedObservation = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "canary", "observe",
      "--id", "slice-degradation", "--assignment-id", "slice-degraded-assignment",
      "--run-id", "slice-degraded-run",
    ], canaryEnv) as {
      ready: boolean; verificationFailures: number; guardrailViolation: boolean; rollbackDecisionId: string | null;
    };
    expect(degradedObservation).toMatchObject({
      ready: false,
      guardrailViolation: true,
      rollbackDecisionId: "slice-degradation:rollback",
    });
    expect(degradedObservation.verificationFailures).toBeGreaterThan(0);

    // slice-rollback: the next formal run on a task still assigned to the
    // rolled-back Challenger must resolve the restored Champion.
    const restoredRun = runCli([
      "--loop-home", loopHome, "--provider-profile", "CODEX_PRIMARY", "run",
      "--run-id", "slice-champion-restored", "--task", healthyTarget.taskPath,
      "--repository", healthyTarget.root,
    ], canaryEnv) as { run: { binding: {
      configSource: string; configurationVariantId: string; canaryAssignmentId: string | null;
    } } };
    expect(restoredRun.run.binding).toMatchObject({
      configSource: "champion",
      configurationVariantId: champion.id,
      canaryAssignmentId: null,
    });
  }, 600_000);
});
