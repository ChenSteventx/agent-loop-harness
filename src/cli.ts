#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { Orchestrator, defaultLoopHome } from "./orchestrator.js";
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  PiAdapter,
  type ProviderAdapter,
  type ProviderRunRequest,
  type ProviderRunResult,
} from "./provider.js";
import { GenericNodeProjectAdapter } from "./project.js";
import { defaultRoleOutputSchemas } from "./role-output-schemas.js";
import { SqliteStore } from "./store.js";
import { exportRunFacts } from "./evaluation/facts.js";
import { projectRunMetrics, summarizeMetrics } from "./evaluation/metrics.js";
import { evaluateReadiness } from "./evaluation/readiness.js";
import { EvaluationStore } from "./evaluation/store.js";
import { DatasetCatalog } from "./evaluation/datasets.js";
import { HistoricalReplay, pinnedVerificationCommit, type ReplayMode } from "./evaluation/replay.js";
import { CommandRunner, GitService } from "./execution.js";
import { operationInputHash } from "./bindings.js";
import {
  approveCandidateMemory,
  deriveCandidateMemories,
  invalidateCandidateMemory,
  rejectCandidateMemory,
  retrieveApprovedMemory,
} from "./memory/candidates.js";
import {
  approveChangeProposal,
  createChangeProposal,
  evolutionTargets,
  promoteChallenger,
  rollbackChampion,
  type EvolutionTarget,
} from "./evolution/proposals.js";
import { disabledCanaryPolicy } from "./evolution/canary.js";
import {
  createProviderProfile,
  providerProfileNames,
  type ProviderProfileName,
} from "./profiles.js";

const program = new Command()
  .name("agent-loop")
  .description("Evidence-driven bounded coding loop")
  .option("--loop-home <path>", "external state directory", process.env.LOOP_HOME ?? defaultLoopHome())
  .option(
    "--provider-profile <name>",
    "fixed Provider profile: CODEX_PRIMARY or CLAUDE_PRIMARY",
    process.env.AGENT_LOOP_PROVIDER_PROFILE ?? "CODEX_PRIMARY",
  );

program
  .command("init")
  .description("initialize the private loop state directory")
  .action(() => {
    const home = resolve(program.opts<{ loopHome: string }>().loopHome);
    mkdirSync(home, { recursive: true });
    const orchestrator = createOrchestrator(home);
    orchestrator.close();
    print({ loopHome: home, initialized: true });
  });

program
  .command("run")
  .requiredOption("--task <path>")
  .requiredOption("--repository <path>")
  .option("--run-id <id>")
  .description("create a worktree and execute the fixed risk-routed proof loop")
  .action(async (options: { task: string; repository: string; runId?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(
        await orchestrator.start({
          runId: options.runId ?? randomUUID(),
          taskPath: resolve(options.task),
          targetRepository: resolve(options.repository),
        }),
      ),
    );
  });

program
  .command("status")
  .option("--run-id <id>")
  .description("show durable run state after completion or interruption")
  .action(async (options: { runId?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(options.runId ? orchestrator.status(options.runId) : orchestrator.listRuns()),
    );
  });

program
  .command("resume")
  .requiredOption("--run-id <id>")
  .option("--task <path>", "deprecated compatibility check; the saved Run binding is authoritative")
  .description("inspect durable facts and continue the next deterministic action")
  .action(async (options: { runId: string; task?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.resume(options.runId, options.task ? resolve(options.task) : undefined)),
    );
  });

program
  .command("verify")
  .requiredOption("--run-id <id>")
  .option("--task <path>", "deprecated compatibility check; the saved Run binding is authoritative")
  .description("run configured verification in the task worktree")
  .action(async (options: { runId: string; task?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.verify(options.runId, options.task ? resolve(options.task) : undefined)),
    );
  });

program
  .command("mark-merged")
  .requiredOption("--run-id <id>")
  .requiredOption("--repository <path>")
  .requiredOption("--merge-sha <sha>")
  .description("record a supplied real merge commit without performing a merge")
  .action(async (options: { runId: string; repository: string; mergeSha: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(orchestrator.markMerged(options.runId, resolve(options.repository), options.mergeSha)),
    );
  });

const metrics = program.command("metrics").description("project metrics from durable development facts");

metrics
  .command("run")
  .requiredOption("--run-id <id>")
  .description("export a sanitized Fact Bundle and project metrics for one Run")
  .action((options: { runId: string }) => {
    withEvaluationStores((development, evaluation) => {
      const facts = evaluation.installFactBundle(exportRunFacts(development, options.runId));
      const projection = projectRunMetrics(facts);
      evaluation.installMetrics(projection, facts.factHash);
      print({ facts, metrics: projection });
    });
  });

metrics
  .command("summary")
  .description("project aggregate metrics while keeping ready and done success separate")
  .action(() => {
    withEvaluationStores((development, evaluation) => {
      const projections = development.listRuns().map((run) => {
        const facts = evaluation.installFactBundle(exportRunFacts(development, run.id));
        const projection = projectRunMetrics(facts);
        evaluation.installMetrics(projection, facts.factHash);
        return projection;
      });
      print(summarizeMetrics(projections));
    });
  });

const evaluation = program.command("eval").description("offline evaluation controls");

evaluation
  .command("readiness")
  .description("show whether real evidence is sufficient for optimization and Canary")
  .action(() => {
    withEvaluationStores((development, evaluationStore) => {
      const realRuns = development.listRuns();
      const factBundles = realRuns.map((run) => exportRunFacts(development, run.id));
      const projections = factBundles.map((facts) => projectRunMetrics(facts));
      const datasets = DatasetCatalog.loadDirectory(resolve("eval")).list("readiness");
      const report = evaluateReadiness({
        realRunCount: realRuns.length,
        resolvedFindingCount: projections.reduce((total, value) =>
          total + value.reviewerFindings.confirmed + value.reviewerFindings.rejected, 0),
        exactReplayCount: evaluationStore.listEvaluationRuns()
          .filter((run) => run.status === "completed" && run.replayability === "exact").length,
        goldenTaskCount: datasets.filter((dataset) => dataset.kind === "golden")
          .reduce((total, dataset) => total + dataset.tasks.length, 0),
        holdoutTaskCount: datasets.filter((dataset) => dataset.kind === "holdout")
          .reduce((total, dataset) => total + dataset.tasks.length, 0),
        completedOfflineComparisons: evaluationStore.listOfflineComparisons()
          .filter((comparison) => comparison.status === "completed" && comparison.guardrailsSatisfied).length,
        completedShadowRuns: evaluationStore.listShadowEvaluations().length,
        humanCanaryApproval: evaluationStore.listCanaryApprovals()
          .some((approval) => approval.authority === "human" && approval.expiresAt > new Date().toISOString()),
        coverageComplete: requiredReadinessCoverage(realRuns, factBundles, projections),
        fixtureOnly: realRuns.length === 0,
      });
      evaluationStore.recordReadiness(report);
      print(report);
    });
  });

evaluation
  .command("replay")
  .requiredOption("--run-id <id>")
  .option("--mode <mode>", "verify-only; full requires an injected full Replay executor", "verify-only")
  .option("--evaluation-id <id>")
  .description("create a separate immutable Evaluation Run without mutating the development Run")
  .action(runReplayCommand);

program
  .command("replay")
  .requiredOption("--run-id <id>")
  .option("--mode <mode>", "verify-only; full requires an injected full Replay executor", "verify-only")
  .option("--evaluation-id <id>")
  .description("top-level alias for immutable Historical Replay")
  .action(runReplayCommand);

evaluation
  .command("compare")
  .option("--project <scope>")
  .description("report immutable Champion/Challenger offline comparisons")
  .action((options: { project?: string }) => {
    withEvaluationStores((_development, store) => print(store.listOfflineComparisons(options.project)));
  });

const shadow = program.command("shadow").description("non-authoritative Shadow reports");
shadow.command("report").option("--project <scope>").action((options: { project?: string }) => {
  withEvaluationStores((_development, store) => print(store.listShadowEvaluations(options.project)));
});

const proposal = program.command("proposal").description("configuration-only Change Proposals");
proposal
  .command("create")
  .requiredOption("--id <id>")
  .requiredOption("--project <scope>")
  .requiredOption("--target <target>")
  .requiredOption("--patch <json>")
  .requiredOption("--rationale <text>")
  .requiredOption("--source-facts <hashes>")
  .option("--minimum-samples <count>", "minimum comparison samples", "5")
  .description("create a bounded proposal; Holdout Tasks remain inaccessible")
  .action((options: {
    id: string; project: string; target: string; patch: string; rationale: string;
    sourceFacts: string; minimumSamples: string;
  }) => {
    withEvaluationStores((_development, store) => {
      const champion = store.activeChampion(options.project);
      if (!champion) throw new Error(`No active Champion for project ${options.project}`);
      const target = parseEvolutionTarget(options.target);
      print(store.installChangeProposal(createChangeProposal({
        id: options.id,
        projectScope: options.project,
        target,
        baseChampion: champion,
        patch: parseObject(options.patch),
        rationale: options.rationale,
        sourceFactHashes: csv(options.sourceFacts),
        datasets: DatasetCatalog.loadDirectory(resolve("eval")).list("proposal"),
        metrics: ["readySuccessRate", "doneSuccessRate", "verificationFailures"],
        minimumSamples: positiveInteger(options.minimumSamples, "minimum samples"),
      })));
    });
  });

proposal
  .command("approve")
  .requiredOption("--id <id>")
  .requiredOption("--approved-by <identity>")
  .requiredOption("--reason <text>")
  .action((options: { id: string; approvedBy: string; reason: string }) => {
    withEvaluationStores((_development, store) => print(approveChangeProposal(store, options)));
  });

const config = program.command("config").description("Champion activation and rollback decisions");
config.command("champion").requiredOption("--project <scope>").action((options: { project: string }) => {
  withEvaluationStores((_development, store) => print(store.activeChampion(options.project)));
});
config
  .command("activate")
  .requiredOption("--proposal-id <id>")
  .requiredOption("--challenger-id <id>")
  .requiredOption("--comparison-id <id>")
  .requiredOption("--decided-by <identity>")
  .requiredOption("--reason <text>")
  .action((options: {
    proposalId: string; challengerId: string; comparisonId: string; decidedBy: string; reason: string;
  }) => {
    withEvaluationStores((_development, store) => {
      const proposalValue = store.getChangeProposal(options.proposalId);
      const challenger = store.getConfigurationVariant(options.challengerId);
      const comparison = store.getOfflineComparison(options.comparisonId);
      if (!proposalValue || !challenger || !comparison) throw new Error("Promotion facts are incomplete");
      const champion = store.activeChampion(proposalValue.projectScope);
      if (!champion) throw new Error("Active Champion is missing");
      print(promoteChallenger(store, {
        id: `promotion:${proposalValue.id}:${Date.now()}`,
        projectScope: proposalValue.projectScope,
        proposalId: proposalValue.id,
        fromChampionId: champion.id,
        challengerId: challenger.id,
        verdict: "promote",
        comparisonId: comparison.id,
        thresholdsSatisfied: comparison.guardrailsSatisfied,
        sampleSize: comparison.sampleSize,
        decidedBy: options.decidedBy,
        reason: options.reason,
        decidedAt: new Date().toISOString(),
      }));
    });
  });
config
  .command("rollback")
  .requiredOption("--project <scope>")
  .requiredOption("--from <variant-id>")
  .requiredOption("--restore <variant-id>")
  .requiredOption("--evidence <hash>")
  .requiredOption("--decided-by <identity>")
  .requiredOption("--reason <text>")
  .action((options: {
    project: string; from: string; restore: string; evidence: string; decidedBy: string; reason: string;
  }) => {
    withEvaluationStores((_development, store) => print(rollbackChampion(store, {
      id: `rollback:${options.project}:${Date.now()}`,
      projectScope: options.project,
      fromChampionId: options.from,
      restoreChampionId: options.restore,
      reason: options.reason,
      triggerEvidenceHash: options.evidence,
      authority: "human",
      decidedBy: options.decidedBy,
      decidedAt: new Date().toISOString(),
    })));
  });

const canary = program.command("canary").description("disabled-by-default low-risk Canary controls");
canary.command("plan").action(() => print(disabledCanaryPolicy));
canary.command("status").option("--project <scope>").action((options: { project?: string }) => {
  withEvaluationStores((_development, store) => print({
    policy: disabledCanaryPolicy,
    approvals: store.listCanaryApprovals(options.project),
    pendingRollbackEvents: store.listPendingEvolutionOutbox(),
  }));
});

const human = program.command("human").description("record explicit human decisions");

human
  .command("resolve")
  .requiredOption("--id <id>")
  .requiredOption("--finding-id <id>")
  .requiredOption("--outcome <outcome>", "confirmed or rejected")
  .option("--note <text>")
  .description("resolve an inconclusive Finding without treating Reviewer output as truth")
  .action((options: { id: string; findingId: string; outcome: string; note?: string }) => {
    const id = Number(options.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Human Inbox id must be a positive integer");
    if (options.outcome !== "confirmed" && options.outcome !== "rejected") {
      throw new Error("Human Finding outcome must be confirmed or rejected");
    }
    const home = resolve(program.opts<{ loopHome: string }>().loopHome);
    const development = new SqliteStore(resolve(home, "state.sqlite"));
    try {
      print(development.resolveHumanInbox(id, {
        type: "finding",
        findingId: options.findingId,
        outcome: options.outcome,
        note: options.note ?? null,
      }));
    } finally {
      development.close();
    }
  });

const memory = program.command("memory").description("quarantined project-scoped Candidate Memory");

memory
  .command("generate")
  .description("derive candidates from sanitized real Fact Bundles without activating retrieval")
  .action(() => {
    withEvaluationStores((_development, evaluationStore) => {
      const values = deriveCandidateMemories(evaluationStore.listLatestFactBundles())
        .map((candidate) => evaluationStore.installCandidateMemory(candidate));
      print(values);
    });
  });

memory
  .command("list")
  .option("--project <scope>")
  .description("list Candidate Memory and explicit decision state")
  .action((options: { project?: string }) => {
    withEvaluationStores((_development, evaluationStore) =>
      print(evaluationStore.listCandidateMemories(options.project)));
  });

memory
  .command("approve")
  .requiredOption("--id <id>")
  .requiredOption("--approved-by <identity>")
  .requiredOption("--reason <text>")
  .option("--forbid <identifiers>", "comma-separated project-specific identifiers")
  .description("record an explicit human approval after contamination and overfit scans")
  .action((options: { id: string; approvedBy: string; reason: string; forbid?: string }) => {
    withEvaluationStores((_development, evaluationStore) => print(approveCandidateMemory(evaluationStore, {
      id: options.id,
      approvedBy: options.approvedBy,
      reason: options.reason,
      forbiddenIdentifiers: options.forbid?.split(",").map((item) => item.trim()).filter(Boolean),
    })));
  });

memory
  .command("reject")
  .requiredOption("--id <id>")
  .requiredOption("--rejected-by <identity>")
  .requiredOption("--reason <text>")
  .description("record an explicit human rejection or rollback of approved memory")
  .action((options: { id: string; rejectedBy: string; reason: string }) => {
    withEvaluationStores((_development, evaluationStore) => print(rejectCandidateMemory(evaluationStore, options)));
  });

memory
  .command("invalidate")
  .requiredOption("--id <id>")
  .requiredOption("--invalidated-by <identity>")
  .requiredOption("--reason <text>")
  .description("invalidate stale or contaminated memory so it cannot be retrieved")
  .action((options: { id: string; invalidatedBy: string; reason: string }) => {
    withEvaluationStores((_development, store) => print(invalidateCandidateMemory(store, options)));
  });

memory
  .command("retrieve")
  .requiredOption("--project <scope>")
  .requiredOption("--query <text>")
  .option("--enable", "explicitly enable otherwise-disabled retrieval", false)
  .description("run explainable lexical retrieval; disabled unless --enable is supplied")
  .action((options: { project: string; query: string; enable: boolean }) => {
    withEvaluationStores((_development, evaluationStore) => print(retrieveApprovedMemory(evaluationStore, {
      projectScope: options.project,
      query: options.query,
      enabled: options.enable,
    })));
  });

async function runReplayCommand(options: { runId: string; mode: string; evaluationId?: string }): Promise<void> {
  const mode = parseReplayMode(options.mode);
  await withEvaluationStoresAsync(async (development, evaluationStore, home) => {
    const run = development.getRun(options.runId);
    if (!run) throw new Error(`Run not found: ${options.runId}`);
    const facts = evaluationStore.installFactBundle(exportRunFacts(development, options.runId));
    const evaluationId = options.evaluationId ?? `replay:${options.runId}:${Date.now()}`;
    const replay = new HistoricalReplay(evaluationStore, async (replayFacts, replayMode, binding) => {
      if (replayMode === "full") throw new Error("FullReplayExecutorUnavailable");
      const commit = pinnedVerificationCommit(replayFacts);
      if (!commit || new GitService(binding.worktreePath).head() !== commit) {
        throw new Error("PinnedVerificationCommitUnavailable");
      }
      const runner = new CommandRunner();
      const receipts = [];
      for (const command of binding.taskSpec.verification) {
        const result = await runner.run({
          argv: command.argv,
          cwd: binding.worktreePath,
          artifactDirectory: resolve(home, "evaluation-runs", evaluationId, command.id),
          environmentAllowlist: [
            "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
          ],
          timeoutMs: 60_000,
          outputLimitBytes: 1024 * 1024,
          shell: false,
        });
        receipts.push({ commandId: command.id, exitCode: result.exitCode, signal: result.signal,
          timedOut: result.timedOut, commitBefore: result.commitBefore });
      }
      const passed = receipts.every((receipt) => receipt.exitCode === 0 && receipt.signal === null &&
        !receipt.timedOut && receipt.commitBefore === commit);
      return {
        passed,
        evidenceHash: operationInputHash(receipts),
        diagnostics: receipts.filter((receipt) => receipt.exitCode !== 0).map((receipt) => receipt.commandId),
      };
    });
    print(await replay.run({
      id: evaluationId,
      facts,
      binding: run.binding,
      mode,
      requiredOperationIds: development.listOperations(options.runId)
        .filter((operation) => ["explorer", "author", "repair", "reviewer"].includes(operation.kind))
        .map((operation) => operation.id),
    }));
  });
}

function createOrchestrator(loopHome: string): Orchestrator {
  const profileName = parseProviderProfileName(
    program.opts<{ providerProfile: string }>().providerProfile,
  );
  const codex = new CodexCliAdapter({
    sandbox: "workspace-write",
    model: process.env.AGENT_LOOP_CODEX_MODEL ?? null,
  });
  const claude = new ClaudeCodeAdapter({
    model: process.env.AGENT_LOOP_CLAUDE_MODEL ?? null,
  });
  const deepseek = configuredPiAdapter();
  return new Orchestrator({
    loopHome,
    providerProfile: createProviderProfile(profileName, {
      codex: { adapter: codex, family: "codex", name: "Codex CLI" },
      claude: { adapter: claude, family: "claude", name: "Claude Code" },
      deepseek: { adapter: deepseek, family: "deepseek", name: "Pi / configured DeepSeek" },
    }),
    projectAdapter: new GenericNodeProjectAdapter(),
    roleOutputSchemas: defaultRoleOutputSchemas(),
  });
}

async function withOrchestrator(action: (orchestrator: Orchestrator) => Promise<void>): Promise<void> {
  const orchestrator = createOrchestrator(resolve(program.opts<{ loopHome: string }>().loopHome));
  try {
    await action(orchestrator);
  } finally {
    orchestrator.close();
  }
}

function withEvaluationStores(action: (development: SqliteStore, evaluation: EvaluationStore) => void): void {
  const home = resolve(program.opts<{ loopHome: string }>().loopHome);
  mkdirSync(home, { recursive: true });
  const development = new SqliteStore(resolve(home, "state.sqlite"));
  const evaluation = new EvaluationStore(resolve(home, "evaluation.sqlite"));
  try {
    action(development, evaluation);
  } finally {
    evaluation.close();
    development.close();
  }
}

async function withEvaluationStoresAsync(
  action: (development: SqliteStore, evaluation: EvaluationStore, home: string) => Promise<void>,
): Promise<void> {
  const home = resolve(program.opts<{ loopHome: string }>().loopHome);
  mkdirSync(home, { recursive: true });
  const development = new SqliteStore(resolve(home, "state.sqlite"));
  const evaluationStore = new EvaluationStore(resolve(home, "evaluation.sqlite"));
  try {
    await action(development, evaluationStore, home);
  } finally {
    evaluationStore.close();
    development.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseProviderProfileName(value: string): ProviderProfileName {
  if (providerProfileNames.includes(value as ProviderProfileName)) return value as ProviderProfileName;
  throw new Error(`Unknown Provider profile: ${value}`);
}

function parseEvolutionTarget(value: string): EvolutionTarget {
  if (evolutionTargets.includes(value as EvolutionTarget)) return value as EvolutionTarget;
  throw new Error(`Forbidden evolution target: ${value}`);
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON value must be an object");
  }
  return parsed as Record<string, unknown>;
}

function csv(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("At least one value is required");
  return values;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredReadinessCoverage(
  runs: ReturnType<SqliteStore["listRuns"]>,
  facts: ReturnType<typeof exportRunFacts>[],
  projections: ReturnType<typeof projectRunMetrics>[],
): boolean {
  const risks = new Set(runs.map((run) => run.binding?.risk).filter(Boolean));
  const taskTypes = new Set(runs.map((run) => run.taskId.split(":", 1)[0]));
  return projections.some((value) => value.readySuccess || value.doneSuccess) &&
    runs.some((run) => ["blocked", "failed", "cancelled"].includes(run.status)) &&
    projections.some((value) => value.verificationFailures > 0) &&
    projections.some((value) => value.repairRounds > 0) &&
    projections.some((value) => value.providerFallbacks > 0) &&
    projections.some((value) => value.humanInboxCount > 0) &&
    risks.has("low") && risks.has("normal") && risks.has("high") &&
    taskTypes.size >= 2 &&
    facts.some((bundle) => bundle.agentCalls.some((call) =>
      !/^(fake|test|fixture)/i.test(call.provider)));
}

function parseReplayMode(value: string): ReplayMode {
  if (value === "full" || value === "verify-only") return value;
  throw new Error(`Unknown Replay mode: ${value}`);
}

function configuredPiAdapter(): ProviderAdapter {
  const provider = process.env.AGENT_LOOP_PI_PROVIDER?.trim();
  const highCapability = process.env.AGENT_LOOP_PI_HIGH_MODEL?.trim();
  const fastAuxiliary = process.env.AGENT_LOOP_PI_FAST_MODEL?.trim();
  if (!provider || !highCapability || !fastAuxiliary) return new UnconfiguredPiAdapter();
  return new PiAdapter({
    provider,
    routes: {
      highCapability: { id: highCapability },
      fastAuxiliary: { id: fastAuxiliary },
    },
    route: "highCapability",
  });
}

class UnconfiguredPiAdapter implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "unverified", workspaceWrite: "unverified" } as const;

  async probe() {
    return { available: false, identity: this.identity(), error: "Pi Provider/model routes are not configured" };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    return {
      invocationId: request.invocationId,
      ok: false,
      cancelled: false,
      identity: this.identity(),
      threadId: null,
      events: [],
      finalOutput: null,
      stderr: "Set AGENT_LOOP_PI_PROVIDER, AGENT_LOOP_PI_HIGH_MODEL, and AGENT_LOOP_PI_FAST_MODEL",
      exitCode: null,
      signal: null,
      durationMs: 0,
      usage: null,
      failureClass: "unavailable",
      eventsPath: resolve(request.artifactDirectory, "events.jsonl"),
      finalOutputPath: resolve(request.artifactDirectory, "final.json"),
      stderrPath: resolve(request.artifactDirectory, "stderr.log"),
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  private identity() {
    return {
      provider: "pi-unconfigured",
      model: null,
      executable: "pi",
      version: null,
    };
  }
}

await program.parseAsync();
