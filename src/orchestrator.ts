import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CommandRunner,
  GitService,
  WorktreeService,
  safeBranchName,
  type CandidateCommit,
} from "./execution.js";
import {
  FindingValidator,
  findingClaimHash,
  isBoundFindingValidationDecision,
  type FindingValidationDecision,
} from "./finding-validator.js";
import type { ProjectAdapter, VerificationCommand } from "./ports.js";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./provider.js";
import { loadTaskSpec } from "./project.js";
import type { TaskSpec } from "./task-spec.js";
import { authorPrompt } from "./roles.js";
import { SqliteStore } from "./store.js";
import type { Evidence, Operation, RecoveryDisposition, Run, RunBinding } from "./domain.js";
import { EvidenceGate } from "./evidence-gate.js";
import { applyRiskEscalation, executionTemplates, type ExecutionTemplateName } from "./routing.js";
import {
  compactExplorerReport,
  explorerReportSchema,
  renderExplorerPrompt,
  runExplorer,
  type ExplorerReport,
} from "./explorer.js";
import { decideNextAction, type NextAction, type ProofGapSnapshot } from "./loop.js";
import { BudgetExceededError, assertPromptWithinBudget, boundedJson, type RunBudget } from "./budget.js";
import { normalizeFailureText } from "./failure-fingerprint.js";
import { LoopController } from "./loop-controller.js";
import {
  acceptanceHash,
  createRunBinding,
  evidenceDependencies,
  evidenceDependencyHash,
  operationInputHash,
  taskSpecHash,
} from "./bindings.js";
import {
  authorOutputSchema,
  defaultRoleOutputSchemas,
  type RoleOutputSchemas,
} from "./role-output-schemas.js";
import {
  independentReviewCandidates,
  withFallbackOutbox,
  workspaceRoleCandidates,
  type ConfiguredProvider,
  type ProviderProfile,
} from "./profiles.js";
import { ProviderSupervisor, type ProviderSupervisorResult } from "./provider-supervisor.js";
import {
  ReviewExecutor,
  ReviewProviderCompletionInterruption,
  providerRunResultFromUnknown,
  reviewReportFromProvider,
} from "./review-executor.js";
import { WriterExecutor, writerBoundaryViolation } from "./writer-executor.js";
import {
  hashReviewDiff,
  isBlockingFinding,
  renderReviewerPrompt,
  reviewReportSchema,
  runReviewer,
  type Finding,
  type ReviewReport,
  type VerificationEvidence,
} from "./reviewer.js";
import {
  createInvocationManifest,
  type InvocationRole,
  type ManifestContextInput,
} from "./evaluation/manifests.js";
import type { RuntimeConfigResolver } from "./runtime-config.js";

export function defaultLoopHome(): string {
  return resolve(homedir(), ".agent-loop-harness");
}

export interface DerivedRunView {
  status: Run["status"];
  nextAction: NextAction | null;
  proofGaps: ProofGapSnapshot | null;
  budget: import("./budget.js").RunBudget | null;
  recovery: import("./domain.js").RecoveryDisposition | null;
}

export interface OrchestratorOptions {
  loopHome?: string;
  provider?: ProviderAdapter;
  providerProfile?: ProviderProfile;
  projectAdapter: ProjectAdapter;
  roleOutputSchemas?: Partial<RoleOutputSchemas>;
  /** @deprecated Supply roleOutputSchemas instead. */
  outputSchemaPath?: string;
  providerProfileName?: string;
  commandRunner?: CommandRunner;
  explorerContextBudget?: number;
  maxLoopSteps?: number;
  runtimeConfigResolver?: Pick<RuntimeConfigResolver, "resolve"> & Partial<Pick<RuntimeConfigResolver, "close">>;
  // memory-retrieval target: returns a rendered approved-memory advisory for
  // the task, or null. Consulted once at run creation and frozen into the
  // binding; absence of a retriever simply yields no advisory (fail-quiet
  // for model input, never for evidence).
  memoryRetriever?: (input: { projectScope: string; task: TaskSpec }) => string | null;
  faults?: {
    afterProviderCompletion?: () => void;
    afterHarnessCommit?: () => void;
    afterVerificationFailure?: () => void;
    afterWriterOperationCreated?: (role: "author" | "repair") => void;
    afterCandidateEvidenceInstalled?: () => void;
    afterExplorerOperationCompleted?: () => void;
    afterReviewProviderCompletion?: () => void;
  };
}

export interface StartRunRequest {
  runId?: string;
  taskPath: string;
  targetRepository: string;
  // Optional escalation: run a stronger template than the risk routing
  // floor (e.g. independent review on a low-risk task). Downgrades are
  // rejected by createRunBinding.
  executionTemplate?: ExecutionTemplateName;
}

export interface RunView {
  run: Run;
  operations: ReturnType<SqliteStore["listOperations"]>;
  evidence: ReturnType<SqliteStore["listEvidence"]>;
  events: ReturnType<SqliteStore["listEvents"]>;
  invocationManifests: ReturnType<SqliteStore["listInvocationManifests"]>;
  worktreePath: string;
  worktreeExists: boolean;
}

interface WriterProviderCompletion {
  operationId: string;
  invocationId: string;
  operationInputHash: string | null;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  failureClass: string | null;
  identity: unknown;
  outputHash: string;
  selectedAdapterIndex?: number;
  attempt?: number;
  configuredAuthor?: { family: string; name: string };
  result?: ProviderRunResult;
}

interface ExplorerProviderCompletion {
  operationId: string;
  operationInputHash: string;
  selectedAdapterIndex: number;
  attempt: number;
  configuredExplorer: { family: string; name: string };
  result: ProviderRunResult;
}

interface ReviewProviderCompletion {
  operationId: string;
  operationInputHash: string;
  selectedAdapterIndex: number;
  attempt: number;
  configuredReviewer: { family: string; name: string };
  result: ProviderRunResult;
}

export class Orchestrator {
  readonly loopHome: string;
  readonly store: SqliteStore;
  private readonly provider: ProviderAdapter;
  private readonly providerProfile: ProviderProfile | null;
  private readonly projectAdapter: ProjectAdapter;
  private readonly roleOutputSchemas: RoleOutputSchemas;
  private readonly commandRunner: CommandRunner;
  private readonly afterProviderCompletion?: () => void;
  private readonly afterHarnessCommit?: () => void;
  private readonly afterVerificationFailure?: () => void;
  private readonly afterWriterOperationCreated?: (role: "author" | "repair") => void;
  private readonly afterCandidateEvidenceInstalled?: () => void;
  private readonly afterExplorerOperationCompleted?: () => void;
  private readonly afterReviewProviderCompletion?: () => void;
  private readonly explorerContextBudget: number;
  private readonly providerProfileName: string;
  private readonly maxLoopSteps: number;
  private readonly runtimeConfigResolver: (Pick<RuntimeConfigResolver, "resolve"> &
    Partial<Pick<RuntimeConfigResolver, "close">>) | null;
  private readonly memoryRetriever: ((input: { projectScope: string; task: TaskSpec }) => string | null) | null;

  constructor(options: OrchestratorOptions) {
    this.loopHome = resolve(options.loopHome ?? process.env.LOOP_HOME ?? defaultLoopHome());
    mkdirSync(this.loopHome, { recursive: true });
    this.store = new SqliteStore(resolve(this.loopHome, "state.sqlite"));
    this.providerProfile = options.providerProfile ?? null;
    this.provider = this.providerProfile?.author.adapter ?? options.provider ?? missingProvider();
    this.projectAdapter = options.projectAdapter;
    const defaults = defaultRoleOutputSchemas();
    const legacySchema = options.outputSchemaPath ? resolve(options.outputSchemaPath) : null;
    this.roleOutputSchemas = {
      author: resolve(options.roleOutputSchemas?.author ?? legacySchema ?? defaults.author),
      explorer: resolve(options.roleOutputSchemas?.explorer ?? legacySchema ?? defaults.explorer),
      reviewer: resolve(options.roleOutputSchemas?.reviewer ?? legacySchema ?? defaults.reviewer),
    };
    this.commandRunner = options.commandRunner ?? new CommandRunner();
    this.afterProviderCompletion = options.faults?.afterProviderCompletion;
    this.afterHarnessCommit = options.faults?.afterHarnessCommit;
    this.afterVerificationFailure = options.faults?.afterVerificationFailure;
    this.afterWriterOperationCreated = options.faults?.afterWriterOperationCreated;
    this.afterCandidateEvidenceInstalled = options.faults?.afterCandidateEvidenceInstalled;
    this.afterExplorerOperationCompleted = options.faults?.afterExplorerOperationCompleted;
    this.afterReviewProviderCompletion = options.faults?.afterReviewProviderCompletion;
    this.explorerContextBudget = options.explorerContextBudget ?? 8_000;
    this.providerProfileName = this.providerProfile?.name ?? options.providerProfileName ?? "LEGACY_SINGLE_PROVIDER";
    this.maxLoopSteps = options.maxLoopSteps ?? 32;
    this.runtimeConfigResolver = options.runtimeConfigResolver ?? null;
    this.memoryRetriever = options.memoryRetriever ?? null;
    if (!Number.isSafeInteger(this.maxLoopSteps) || this.maxLoopSteps <= 0) {
      throw new Error("maxLoopSteps must be a positive integer");
    }
  }

  close(): void {
    this.store.close();
    this.runtimeConfigResolver?.close?.();
  }

  async start(request: StartRunRequest): Promise<RunView> {
    const taskPath = resolve(request.taskPath);
    const task = loadTaskSpec(taskPath);
    const runId = request.runId ?? randomUUID();
    if (this.store.getRun(runId)) throw new Error(`Run already exists: ${runId}`);
    const sourceGit = new GitService(request.targetRepository);
    const minimumRisk = this.projectAdapter.minimumRisk({ task });
    const effectiveRisk = applyRiskEscalation(minimumRisk, task.risk);
    const runtimeConfiguration = this.runtimeConfigResolver?.resolve({
      projectScope: this.projectAdapter.name,
      taskKey: task.id,
      effectiveRisk,
    });
    const memoryAdvisory = runtimeConfiguration?.configuration?.memoryRetrievalEnabled
      ? this.memoryRetriever?.({ projectScope: this.projectAdapter.name, task }) ?? null
      : null;
    const worktreePath = this.worktreePath(runId);
    const binding = createRunBinding({
      taskSpecPath: taskPath,
      taskSpec: task,
      baselineCommit: sourceGit.head(),
      sourceRepository: sourceGit.root,
      worktreePath,
      providerProfile: this.providerProfileName,
      projectAdapter: this.projectAdapter,
      effectiveRisk,
      executionTemplate: request.executionTemplate,
      runtimeConfiguration,
      memoryAdvisory,
    });
    this.store.createBoundRun(runId, task.id, binding);
    this.store.appendEvent(runId, "worktree.planned", {
      sourceRepository: sourceGit.root,
      worktreePath,
    });
    const worktree = new WorktreeService(sourceGit.root).create(
      worktreePath,
      safeBranchName(task.id, runId),
    );
    this.store.appendEvent(runId, "worktree.created", worktree);

    return this.runUntilStable(runId);
  }

  // Non-persisted view derived from the same snapshot/decision code the loop
  // itself uses: no second source of truth, nothing new in the database.
  derivedView(runId: string): DerivedRunView {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "open" && run.status !== "ready") {
      return {
        status: run.status,
        nextAction: null,
        proofGaps: null,
        budget: run.binding?.budget ?? null,
        recovery: run.blocked?.recovery ?? null,
      };
    }
    try {
      const snapshot = this.proofGapSnapshot(runId, { reconcile: false });
      return {
        status: run.status,
        nextAction: decideNextAction(snapshot),
        proofGaps: snapshot,
        budget: run.binding?.budget ?? null,
        recovery: null,
      };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return {
          status: run.status,
          nextAction: { kind: "block", reason: error.message },
          proofGaps: null,
          budget: run.binding?.budget ?? null,
          recovery: null,
        };
      }
      throw error;
    }
  }

  status(runId: string): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const worktreePath = run.binding?.worktreePath ?? this.worktreePath(runId);
    return {
      run,
      operations: this.store.listOperations(runId),
      evidence: this.store.listEvidence(runId),
      events: this.store.listEvents(runId),
      invocationManifests: this.store.listInvocationManifests(runId),
      worktreePath,
      worktreeExists: existsSync(worktreePath),
    };
  }

  listRuns(): Run[] {
    return this.store.listRuns();
  }

  markMerged(runId: string, repository: string, mergeSha: string): RunView {
    assertCommit(repository, mergeSha);
    const root = new GitService(repository).root;
    if (new GitService(root).head() !== mergeSha) {
      throw new Error("Merge SHA must be the current HEAD of the supplied repository");
    }
    this.store.transitionRun(runId, "merged", { mergeSha }, { mergeSha, repository: root });
    return this.status(runId);
  }

  async verify(runId: string, legacyTaskPath?: string): Promise<RunView> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "open") throw new Error(`Run ${runId} must be open to verify; current status is ${run.status}`);
    const task = this.loadBoundTask(runId, legacyTaskPath);
    if (!task) return this.status(runId);
    return this.runUntilStable(runId);
  }

  async resume(runId: string, legacyTaskPath?: string): Promise<RunView> {
    let run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status === "done" || run.status === "failed" || run.status === "cancelled") return this.status(runId);
    const task = this.loadBoundTask(runId, legacyTaskPath);
    if (!task) return this.status(runId);
    if (run.status === "blocked") {
      const checkpoint = this.store.getOperation(run.blocked?.checkpointRef ?? "");
      if (checkpoint?.status === "failed") return this.status(runId);
      run = this.store.resumeRun(runId);
    }

    if (run.status === "merged") return this.completeMergedRun(runId, task);
    const worktreePath = this.requireBoundRun(runId).binding.worktreePath;
    if (!existsSync(worktreePath)) {
      this.block(runId, "Task worktree is missing", "worktree");
      return this.status(runId);
    }
    if (run.status === "ready") {
      try {
        if (this.nextAction(runId).kind === "advance-ready") return this.status(runId);
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          this.block(runId, error.message, "budget-exceeded");
          return this.status(runId);
        }
        throw error;
      }
      this.store.reopenRunForInvalidEvidence(runId);
    }
    return this.runUntilStable(runId);
  }

  private async runUntilStable(runId: string): Promise<RunView> {
    return new LoopController<RunView>(this.maxLoopSteps).run({
      isActive: () => this.store.getRun(runId)?.status === "open",
      status: () => this.status(runId),
      // Snapshot construction reads workspace diffs, so budget hits can
      // surface during action SELECTION as well as execution; both must
      // resolve to a blocked run rather than a crashed entry point.
      nextAction: () => {
        try {
          return this.nextAction(runId);
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            this.block(runId, error.message, "budget-exceeded");
            return { kind: "block", reason: error.message };
          }
          throw error;
        }
      },
      recordAction: (step, action) => this.store.appendEvent(runId, "loop.action", { step, action }),
      execute: (action) => this.executeLoopAction(runId, action),
      exhausted: () => {
        this.block(runId, "Loop step budget exhausted", "loop-budget");
        return this.status(runId);
      },
    });
  }

  private async executeLoopAction(runId: string, action: NextAction): Promise<RunView | null> {
    try {
      return await this.executeLoopActionInner(runId, action);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        // A budget hit is a deterministic verdict about the workspace or the
        // model output, not a transient fault: block instead of crashing.
        this.block(runId, error.message, "budget-exceeded");
        return this.status(runId);
      }
      throw error;
    }
  }

  private async executeLoopActionInner(runId: string, action: NextAction): Promise<RunView | null> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (action.kind === "resolve-risk") {
      if (this.store.listHumanInbox(runId).length === 0) {
        this.store.createHumanInbox(runId, {
          question: "Classify this task risk before execution",
          options: ["low", "normal", "high", "cancel"],
          recommendation: "high",
          evidence: { taskId: run.taskId, taskSpecHash: run.binding?.taskSpecHash },
          risk: "unknown",
          consequence: "The Harness cannot select a safe fixed template",
          resumeCommand: `agent-loop resume --run-id ${runId}`,
        });
      }
      this.block(runId, "Risk must be classified before execution", "risk-classification");
      return this.status(runId);
    }
    if (action.kind === "explore") await this.executeExplorer(runId);
    else if (action.kind === "author") await this.executeWriter(runId, "author", action.attempt);
    else if (action.kind === "checkpoint-commit") this.executeCheckpointCommit(runId);
    else if (action.kind === "bind-acceptance") this.executeAcceptanceBinding(runId);
    else if (action.kind === "verify") await this.executeVerification(runId);
    else if (action.kind === "repair") await this.executeWriter(runId, "repair", action.attempt);
    else if (action.kind === "review") await this.executeReview(runId);
    else if (action.kind === "advance-ready") {
      const commitSha = new GitService(this.requireBoundRun(runId).binding.worktreePath, this.requireBoundRun(runId).binding.budget).head();
      this.store.transitionRun(runId, "ready", {}, { commitSha });
      return this.status(runId);
    } else if (action.kind === "block") {
      this.block(runId, this.durableBlockReason(runId, action.reason), this.failureCheckpoint(runId));
      return this.status(runId);
    }
    return null;
  }

  private nextAction(runId: string): NextAction {
    return decideNextAction(this.proofGapSnapshot(runId));
  }

  private proofGapSnapshot(runId: string, options: { reconcile?: boolean } = {}): ProofGapSnapshot {
    const run = this.requireBoundRun(runId);
    const binding = run.binding;
    const git = new GitService(binding.worktreePath, binding.budget);
    // Reconciliation invalidates stale commit-bound evidence — a write. The
    // derived status view must observe without mutating, so it opts out.
    if (options.reconcile !== false) this.reconcileCommitBoundEvidence(runId, git.head());
    const operations = this.store.listOperations(runId);
    const allEvidence = this.store.listEvidence(runId);
    const evidenceGate = new EvidenceGate(allEvidence);
    const validEvidence = evidenceGate.validEvidence();
    const template = executionTemplates[binding.executionTemplate];

    const explorer = operations.find((operation) => operation.kind === "explorer");
    const explorerDependencyHash = explorer
      ? this.explorationEvidenceReceipt(runId, explorer).dependencyHash
      : null;
    const exploration = !template.requiresExplorer
      ? "not-required"
      : explorerDependencyHash && validEvidence.some((item) =>
          item.kind === "exploration" && item.dependencyHash === explorerDependencyHash
        )
        ? "satisfied"
        : explorer?.status === "failed"
          ? "failed"
          : "missing";

    const writers = operations.filter((operation) => operation.kind === "author" || operation.kind === "repair");
    const writer = writers.at(-1);
    const recoveringCheckpoint = operations.some((operation) =>
      operation.kind === "checkpoint-commit" && operation.status === "running"
    );
    const savedCheckpoint = operations.some((operation) =>
      operation.kind === "checkpoint-commit" && operation.status === "succeeded"
    );
    const currentCandidate = evidenceGate.has("candidate_commit", (item) => item.commitSha === git.head());
    let writerProof: ProofGapSnapshot["writer"];
    if (git.isDirty()) {
      writerProof = writer && (writer.status === "running" || writer.status === "succeeded")
        ? "patch-ready"
        : "failed";
    } else if (recoveringCheckpoint || (savedCheckpoint && !currentCandidate)) writerProof = "patch-ready";
    else if (writer?.status === "running") writerProof = "running";
    else if (currentCandidate) writerProof = "committed";
    else if (!writer) writerProof = "missing";
    else if (writer.status === "failed") writerProof = "failed";
    else writerProof = "running";

    const commands = this.projectAdapter.verificationCommands(binding.taskSpec);
    const expectedCommandHashes = commands.map((command) =>
      this.commandEvidenceReceipt(runId, git.head(), binding.worktreePath, "verify", command).dependencyHash
    );
    const currentFailures = evidenceGate.matching("verification_failure", (item) => item.commitSha === git.head());
    const verification = evidenceGate.verificationStatus(git.head(), expectedCommandHashes);

    const acceptanceReceipt = this.acceptanceEvidenceReceipt(runId, git.head());
    const acceptance = !template.requiresIndependentReview
      ? "not-required"
      : evidenceGate.has("acceptance_binding", (item) => item.dependencyHash === acceptanceReceipt.dependencyHash)
        ? "satisfied"
        : "missing";

    let review: ProofGapSnapshot["review"] = "not-required";
    if (template.requiresIndependentReview && acceptance === "satisfied" && verification === "passed") {
      const candidates = this.safeReviewCandidates(runId);
      const reviewInput = this.reviewOperationInput(
        runId,
        git.head(),
        hashReviewDiff(git.diffBetween(binding.baselineCommit, git.head())),
        git.controlStateHash(),
        candidates,
      );
      const reviewOperation = this.store.getOperation(this.reviewOperationId(runId, git.head(), reviewInput));
      const receipt = validEvidence.find((item) =>
        item.kind === "independent_review" &&
        item.commitSha === git.head() &&
        reviewOperation !== null &&
        candidates.some((candidate) =>
          this.matchesReviewEvidence(runId, item, candidate, reviewOperation, reviewInput)
        )
      );
      if (receipt) {
        review = isRecord(receipt.data) && receipt.data.blocking === true ? "blocking" : "passed";
      } else if (reviewOperation?.status === "failed") {
        review = "unavailable";
      } else {
        review = "missing";
      }
    }

    const latestFailure = currentFailures.at(-1);
    const signature = failureEvidenceSignature(latestFailure);
    const repeatedFailure = signature !== null && allEvidence.some((item) =>
      item.id !== latestFailure?.id && failureEvidenceSignature(item) === signature
    );
    const repairsUsed = operations.filter((operation) => operation.kind === "repair").length;
    return {
      risk: binding.risk,
      template: binding.executionTemplate,
      exploration,
      writer: writerProof,
      acceptance,
      verification,
      review,
      repairsUsed,
      maximumRepairs: template.maximumRepairs,
      repeatedFailure,
    };
  }

  private async executeExplorer(runId: string): Promise<void> {
    const run = this.requireBoundRun(runId);
    const binding = run.binding;
    const candidates = this.providerProfile
      ? this.orderProviderCandidates(binding, workspaceRoleCandidates(this.providerProfile, "read-only"))
      : [];
    if (this.providerProfile && candidates.length === 0) {
      this.requireHumanReview(
        runId,
        "No configured Explorer can prove read-only isolation",
        {
          profile: this.providerProfile.name,
          configuredExplorers: [this.providerProfile.author, this.providerProfile.fallbackAuthor].map(configuredProviderFact),
        },
        "provider-isolation",
      );
      return;
    }
    const git = new GitService(binding.worktreePath, binding.budget);
    const before = git.state();
    const beforeControlState = git.controlStateHash();
    const operation = this.store.createOperation({
      id: `${runId}:explorer`,
      runId,
      kind: "explorer",
      idempotencyKey: `${runId}:explorer`,
      input: {
        taskSpecHash: binding.taskSpecHash,
        baselineCommit: binding.baselineCommit,
        currentCommit: before.head,
        gitControlHash: beforeControlState,
        contextBudget: this.explorerContextBudget,
      },
    });
    if (operation.status === "succeeded") {
      this.installExplorationEvidence(runId, operation);
      return;
    }
    if (operation.status !== "running") return;
    const savedCompletion = this.explorerProviderCompletion(runId, operation.id);
    if (savedCompletion) {
      const selected = candidates[savedCompletion.selectedAdapterIndex];
      const input = explorerOperationInput(operation.input);
      const report = explorerReportSchema.safeParse(savedCompletion.result.finalOutput);
      if (
        savedCompletion.operationInputHash !== operation.inputHash ||
        !selected ||
        selected.family !== savedCompletion.configuredExplorer.family ||
        selected.name !== savedCompletion.configuredExplorer.name ||
        !report.success ||
        git.head() !== input.currentCommit ||
        git.isDirty() ||
        git.controlStateHash() !== input.gitControlHash
      ) {
        this.store.finishOperation(operation.id, "failed", {
          reason: "Recovered Explorer completion no longer matches its read-only boundary",
          providerCompletion: savedCompletion,
        });
        return;
      }
      this.installRoleInvocationManifest({
        runId,
        operation,
        role: "explorer",
        renderedPrompt: renderExplorerPrompt({
          task: binding.taskSpec,
          baselineCommit: binding.baselineCommit,
          currentCommit: input.currentCommit,
          allowedRepositoryRoots: [binding.worktreePath],
          contextBudget: this.explorerContextBudget,
        }),
        outputSchemaPath: this.roleOutputSchemas.explorer,
        actualProvider: savedCompletion.result.identity,
        configuredProvider: selected,
        currentCommit: input.currentCommit,
      });
      const completed = this.store.finishOperation(operation.id, "succeeded", {
        report: report.data,
        costTokens: providerUsageTokens(savedCompletion.result),
        latencyMs: savedCompletion.result.durationMs,
        used: true,
        selectedExplorer: configuredProviderFact(selected),
        recoveredAfterProviderCompletion: true,
      });
      this.installExplorationEvidence(runId, completed);
      return;
    }

    let provider = this.provider;
    let supervised: SupervisedRoleAdapter | null = null;
    if (this.providerProfile) {
      const persistence = withFallbackOutbox({
        saveCheckpoint: (checkpoint) => {
          const selected = candidates[checkpoint.selectedAdapterIndex];
          if (!selected) throw new Error("Provider Supervisor selected an unknown Explorer adapter");
          this.store.appendEvent(runId, "explorer.provider-completed", {
            operationId: operation.id,
            operationInputHash: operation.inputHash,
            selectedAdapterIndex: checkpoint.selectedAdapterIndex,
            attempt: checkpoint.attempt,
            configuredExplorer: configuredProviderFact(selected),
            result: checkpoint.result,
          });
          this.store.appendEvent(runId, "provider.checkpoint", {
            invocationId: checkpoint.invocationId,
            provider: checkpoint.provider,
            threadId: checkpoint.threadId,
            selectedAdapterIndex: checkpoint.selectedAdapterIndex,
            attempt: checkpoint.attempt,
            role: "explorer",
          });
        },
        saveFailure: (failure) => this.store.appendEvent(runId, "provider.failure", { role: "explorer", ...failure }),
        saveFallback: (fallback) => this.store.appendEvent(runId, "provider.fallback", { role: "explorer", ...fallback }),
      }, this.store, runId);
      supervised = new SupervisedRoleAdapter(new ProviderSupervisor({
        adapters: candidates.map((candidate) => candidate.adapter),
        maxAttempts: (binding.runtimeConfiguration?.retryLimit ?? 1) + 1,
        persistence,
        authRecoveryCommand: `Authenticate a configured Explorer, then run: agent-loop resume --run-id ${runId}`,
        unknownRecoveryCommand: `Inspect Explorer artifacts, then run: agent-loop resume --run-id ${runId}`,
      }), (result) => explorerReportSchema.safeParse(result.finalOutput).success, "Explorer");
      provider = supervised;
    }

    const result = await runExplorer(provider, {
      task: binding.taskSpec,
      baselineCommit: binding.baselineCommit,
      currentCommit: before.head,
      allowedRepositoryRoots: [binding.worktreePath],
      contextBudget: this.explorerContextBudget,
    }, {
      invocationId: operation.id,
      cwd: binding.worktreePath,
      artifactDirectory: resolve(this.loopHome, "runs", runId, "explorer"),
      outputSchemaPath: this.roleOutputSchemas.explorer,
      maximumPromptBytes: binding.budget.maximumPromptBytes,
      model: binding.runtimeConfiguration?.roleModels["explorer"] ?? null,
    });
    const selected = supervised?.outcome?.selectedAdapterIndex === null || supervised?.outcome?.selectedAdapterIndex === undefined
      ? null
      : candidates[supervised.outcome.selectedAdapterIndex] ?? null;
    if (!this.providerProfile || supervised?.outcome?.result) {
      this.installRoleInvocationManifest({
        runId,
        operation,
        role: "explorer",
        renderedPrompt: result.renderedPrompt,
        outputSchemaPath: this.roleOutputSchemas.explorer,
        actualProvider: result.provider.identity,
        configuredProvider: selected,
        currentCommit: before.head,
      });
    }
    if (this.providerProfile && (!result.report || !supervised?.outcome?.result || !selected)) {
      const providerBlock = {
        reason: "No configured Explorer produced a valid structured report",
        supervisor: supervised?.outcome ?? null,
      };
      this.store.appendEvent(runId, "explorer.provider-blocked", {
        operationId: operation.id,
        operationInputHash: operation.inputHash,
        ...providerBlock,
      });
      this.requireHumanReview(runId, "Explorer is unavailable", providerBlock, "provider-recovery",
        providerRecoveryDisposition(supervised?.outcome ?? null));
      return;
    }
    this.store.recordAgentCall(runId, {
      role: "explorer",
      provider: result.provider.identity.provider,
      latencyMs: result.latencyMs,
      usage: result.provider.usage,
    });
    const after = git.state();
    if (
      after.head !== before.head ||
      after.dirty ||
      after.diffHash !== before.diffHash ||
      git.controlStateHash() !== beforeControlState
    ) {
      this.store.finishOperation(operation.id, "failed", {
        reason: "Explorer violated the read-only workspace boundary",
        provider: result.provider,
      });
      return;
    }
    const completed = this.store.finishOperation(operation.id, result.report ? "succeeded" : "failed", {
      report: result.report,
      costTokens: result.costTokens,
      latencyMs: result.latencyMs,
      used: result.used,
      failureClass: result.provider.failureClass,
      selectedExplorer: selected ? configuredProviderFact(selected) : null,
    });
    this.afterExplorerOperationCompleted?.();
    if (completed.status === "succeeded") this.installExplorationEvidence(runId, completed);
  }

  private async executeWriter(
    runId: string,
    role: "author" | "repair",
    attempt: number,
  ): Promise<void> {
    const run = this.requireBoundRun(runId);
    const binding = run.binding;
    const candidates = this.providerProfile
      ? this.orderProviderCandidates(binding, workspaceRoleCandidates(this.providerProfile, "workspace-write"))
      : [];
    if (this.providerProfile && candidates.length === 0) {
      this.requireHumanReview(
        runId,
        "No configured Author can prove workspace-write isolation",
        {
          profile: this.providerProfile.name,
          configuredAuthors: [this.providerProfile.author, this.providerProfile.fallbackAuthor].map(configuredProviderFact),
        },
        "provider-isolation",
      );
      return;
    }
    const git = new GitService(binding.worktreePath, binding.budget);
    if (git.isDirty()) {
      this.block(runId, `${role} cannot start from a dirty worktree`, "worktree");
      return;
    }
    const failureEvidence = role === "repair"
      ? this.store.listEvidence(runId, "valid").filter((item) =>
          item.commitSha === git.head() &&
          (item.kind === "verification_failure" ||
            (item.kind === "independent_review" && isRecord(item.data) && item.data.blocking === true))
        )
      : [];
    const operationId = role === "author" ? `${runId}:author` : `${runId}:repair:${attempt}`;
    const input = {
      role,
      attempt,
      baseCommit: git.head(),
      gitControlHash: git.controlStateHash(),
      taskSpecHash: binding.taskSpecHash,
      acceptanceHash: binding.acceptanceHash,
      configuredAuthor: this.providerProfile ? configuredProviderFact(this.providerProfile.author) : null,
      configuredAuthors: candidates.map(configuredProviderFact),
      failureEvidenceIds: failureEvidence.map((item) => item.id),
      failureSignatures: failureEvidence.map(failureEvidenceSignature).filter((value): value is string => value !== null),
    };
    const existingOperation = this.store.getOperation(operationId);
    const operation = this.store.createOperation({
      id: operationId,
      runId,
      kind: role,
      idempotencyKey: operationId,
      input,
    });
    if (operation.status !== "running") return;
    const completedReceipt = this.writerProviderReceipt(runId, operation.id);
    if (completedReceipt) {
      this.recoverWriterOperation(runId, operation, git);
      return;
    }
    if (!existingOperation) this.afterWriterOperationCreated?.(role);
    const explorerReport = this.savedExplorerReport(runId);
    const writerPrompt = role === "author"
      ? authorPrompt(binding.taskSpec, explorerReport
        ? compactExplorerReport(explorerReport, binding.budget.maximumExplorerAdvisoryBytes)
        : null, { variant: binding.runtimeConfiguration?.promptVariant, memoryAdvisory: binding.memoryAdvisory })
      : repairPrompt(binding.taskSpec, attempt, git.head(), failureEvidence, binding.budget);
    assertPromptWithinBudget(writerPrompt, binding.budget.maximumPromptBytes, role);
    const request: ProviderRunRequest = {
      invocationId: operation.id,
      prompt: writerPrompt,
      cwd: binding.worktreePath,
      artifactDirectory: this.writerArtifactDirectory(runId, role, attempt),
      outputSchemaPath: this.roleOutputSchemas.author,
      workspaceAccess: "workspace-write",
      allowedRepositoryRoots: [binding.worktreePath],
      // Repair is the same writer seat, so it uses the author's model.
      model: binding.runtimeConfiguration?.roleModels["author"] ?? null,
    };
    const persistence = this.providerProfile
      ? withFallbackOutbox({
        saveCheckpoint: (checkpoint) => {
          const selected = candidates[checkpoint.selectedAdapterIndex];
          if (!selected) throw new Error("Provider Supervisor selected an unknown Author adapter");
          this.store.appendEvent(runId, "writer.provider-completed", {
            operationId: operation.id,
            invocationId: checkpoint.result.invocationId,
            operationInputHash: operation.inputHash,
            ok: checkpoint.result.ok,
            exitCode: checkpoint.result.exitCode,
            signal: checkpoint.result.signal,
            failureClass: checkpoint.result.failureClass,
            identity: checkpoint.result.identity,
            outputHash: operationInputHash(checkpoint.result.finalOutput),
            selectedAdapterIndex: checkpoint.selectedAdapterIndex,
            attempt: checkpoint.attempt,
            configuredAuthor: configuredProviderFact(selected),
            result: checkpoint.result,
          });
          this.store.appendEvent(runId, "provider.checkpoint", {
            invocationId: checkpoint.invocationId,
            provider: checkpoint.provider,
            threadId: checkpoint.threadId,
            selectedAdapterIndex: checkpoint.selectedAdapterIndex,
            attempt: checkpoint.attempt,
            role,
          });
          this.afterProviderCompletion?.();
        },
        saveFailure: (failure) => this.store.appendEvent(runId, "provider.failure", { role, ...failure }),
        saveFallback: (fallback) => this.store.appendEvent(runId, "provider.fallback", { role, ...fallback }),
        }, this.store, runId)
      : null;
    const execution = await new WriterExecutor().execute({
      request,
      legacyProvider: this.provider,
      candidates,
      persistence,
      authRecoveryCommand: `Authenticate a configured Author, then run: agent-loop resume --run-id ${runId}`,
      unknownRecoveryCommand: `Inspect Author artifacts, then run: agent-loop resume --run-id ${runId}`,
    });
    if (!this.providerProfile && execution.result) {
      const legacyResult = execution.result;
      this.store.appendEvent(runId, "writer.provider-completed", {
        operationId: operation.id,
        invocationId: legacyResult.invocationId,
        operationInputHash: operation.inputHash,
        ok: legacyResult.ok,
        exitCode: legacyResult.exitCode,
        signal: legacyResult.signal,
        failureClass: legacyResult.failureClass,
        identity: legacyResult.identity,
        outputHash: operationInputHash(legacyResult.finalOutput),
        result: legacyResult,
      });
      this.afterProviderCompletion?.();
    }
    const providerResult = execution.result;
    const selectedAuthor = execution.selectedAuthor;
    if (providerResult) {
      this.installRoleInvocationManifest({
        runId,
        operation,
        role,
        renderedPrompt: request.prompt,
        outputSchemaPath: this.roleOutputSchemas.author,
        actualProvider: providerResult.identity,
        configuredProvider: selectedAuthor,
        currentCommit: input.baseCommit,
        context: [
          ...(explorerReport ? [{
            kind: "explorer-report",
            reference: `${runId}:explorer`,
            content: explorerReport,
            trust: "untrusted" as const,
          }] : []),
          ...failureEvidence.map((item) => ({
            kind: "failure-evidence",
            reference: item.id,
            content: item.data,
            trust: "trusted" as const,
          })),
        ],
      });
    }
    if (execution.disposition === "blocked" || !providerResult) {
      const providerBlock = {
        reason: "No configured Author produced a valid structured result",
        supervisor: execution.supervisor,
      };
      this.store.appendEvent(runId, "writer.provider-blocked", {
        operationId: operation.id,
        operationInputHash: operation.inputHash,
        role,
        ...providerBlock,
      });
      this.requireHumanReview(runId, "Author is unavailable", providerBlock, "provider-recovery",
        providerRecoveryDisposition(execution.supervisor));
      return;
    }
    this.store.recordAgentCall(runId, {
      role,
      provider: providerResult.identity.provider,
      latencyMs: providerResult.durationMs,
      usage: providerResult.usage,
    });
    if (!providerResult.ok) {
      this.store.finishOperation(operation.id, "failed", providerResult);
      return;
    }
    const output = authorOutputSchema.safeParse(providerResult.finalOutput);
    const reason = writerBoundaryViolation(git, input.baseCommit, output.success, input.gitControlHash);
    if (reason) {
      this.store.finishOperation(operation.id, "failed", { provider: providerResult, reason });
      return;
    }
    this.store.finishOperation(operation.id, "succeeded", {
      provider: providerResult,
      report: output.success ? output.data : null,
      worktreePath: binding.worktreePath,
      baseCommit: input.baseCommit,
      workingDiffHash: git.diffHash(),
      selectedAuthor: selectedAuthor ? configuredProviderFact(selectedAuthor) : null,
    });
  }

  private executeCheckpointCommit(runId: string): void {
    const run = this.requireBoundRun(runId);
    const git = new GitService(run.binding.worktreePath, run.binding.budget);
    let writer = this.store.listOperations(runId)
      .filter((operation) => operation.kind === "author" || operation.kind === "repair")
      .at(-1);
    if (!writer) {
      this.block(runId, "No writer operation can own the pending diff", "checkpoint-commit");
      return;
    }
    if (writer.status === "running") writer = this.recoverWriterOperation(runId, writer, git);
    if (writer.status !== "succeeded") {
      this.block(runId, this.durableBlockReason(runId, "Writer receipt is not recoverable"), writer.id);
      return;
    }
    const input = writerOperationInput(writer.input);
    const commitAttempt = writer.kind === "author" ? 1 : input.attempt + 1;
    const candidate = this.ensureCandidateCommit(runId, git, writer.id, commitAttempt, input.baseCommit);
    if (!candidate) return;
    this.afterCandidateEvidenceInstalled?.();
  }

  private executeAcceptanceBinding(runId: string): void {
    const run = this.requireBoundRun(runId);
    const git = new GitService(run.binding.worktreePath, run.binding.budget);
    if (git.isDirty()) {
      this.block(runId, "Acceptance binding requires a clean Harness candidate", "acceptance-binding");
      return;
    }
    const receipt = this.acceptanceEvidenceReceipt(runId, git.head());
    let operation = this.store.createOperation({
      id: receipt.operationId,
      runId,
      kind: "acceptance-binding",
      idempotencyKey: receipt.operationId,
      input: receipt.operationInput,
    });
    if (operation.status === "running") {
      operation = this.store.finishOperation(operation.id, "succeeded", {
        commitSha: git.head(),
        taskSpecHash: run.binding.taskSpecHash,
        acceptanceHash: run.binding.acceptanceHash,
        policyVersion: run.binding.policyVersion,
        acceptance: run.binding.taskSpec.acceptance,
      });
    }
    if (operation.status !== "succeeded") {
      this.block(runId, "Acceptance binding could not be established", operation.id);
      return;
    }
    this.store.installEvidence({
      id: `${runId}:evidence:acceptance:${receipt.dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "acceptance_binding",
      commitSha: git.head(),
      policyVersion: run.binding.policyVersion,
      stepId: receipt.stepId,
      dependencyHash: receipt.dependencyHash,
      dependencies: receipt.dependencies,
      data: operation.result,
    });
  }

  private async executeReview(runId: string): Promise<void> {
    const run = this.requireBoundRun(runId);
    const candidates = this.safeReviewCandidates(runId);
    const actualAuthor = this.actualAuthor(runId);
    if (!this.providerProfile || candidates.length === 0) {
      this.requireHumanReview(
        runId,
        "No independently configured Reviewer can prove read-only isolation",
        {
          profile: this.providerProfile?.name ?? null,
          author: actualAuthor ? configuredProviderFact(actualAuthor) : null,
          configuredReviewers: this.providerProfile
            ? [this.providerProfile.reviewer, this.providerProfile.fallbackReviewer].map(configuredProviderFact)
            : [],
        },
        "independent-review",
      );
      return;
    }

    const binding = run.binding;
    const git = new GitService(binding.worktreePath, binding.budget);
    if (git.isDirty()) {
      this.requireHumanReview(
        runId,
        "Independent review requires a clean Harness candidate",
        { commitSha: git.head() },
        "independent-review",
      );
      return;
    }
    const reviewedCommit = git.head();
    const diff = git.diffBetween(binding.baselineCommit, reviewedCommit);
    const diffHash = hashReviewDiff(diff);
    const controlStateHash = git.controlStateHash();
    const operationInput = this.reviewOperationInput(runId, reviewedCommit, diffHash, controlStateHash, candidates);
    const operationId = this.reviewOperationId(runId, reviewedCommit, operationInput);
    let operation = this.store.createOperation({
      id: operationId,
      runId,
      kind: "independent-review",
      idempotencyKey: operationId,
      input: operationInput,
    });
    if (operation.status === "succeeded") {
      if (!this.installSavedReviewEvidence(runId, operation, candidates)) {
        this.requireHumanReview(
          runId,
          "Saved independent review cannot prove a valid bound receipt",
          { operationId: operation.id },
          operation.id,
        );
      }
      return;
    }
    if (operation.status === "failed") {
      this.requireHumanReview(
        runId,
        "Independent review previously failed",
        { operationId: operation.id, result: operation.result },
        operation.id,
      );
      return;
    }

    const savedCompletion = this.reviewProviderCompletion(runId, operation.id);
    if (savedCompletion) {
      await this.recoverReviewOperation(runId, operation, candidates, savedCompletion);
      return;
    }

    const persistence = withFallbackOutbox({
      saveCheckpoint: (checkpoint) => {
        const selected = candidates[checkpoint.selectedAdapterIndex];
        if (!selected) throw new Error("Provider Supervisor selected an unknown Reviewer adapter");
        this.store.appendEvent(runId, "review.provider-completed", {
          operationId: operation.id,
          operationInputHash: operation.inputHash,
          selectedAdapterIndex: checkpoint.selectedAdapterIndex,
          attempt: checkpoint.attempt,
          configuredReviewer: configuredProviderFact(selected),
          result: checkpoint.result,
        });
        this.store.appendEvent(runId, "provider.checkpoint", {
          invocationId: checkpoint.invocationId,
          provider: checkpoint.provider,
          threadId: checkpoint.threadId,
          selectedAdapterIndex: checkpoint.selectedAdapterIndex,
          attempt: checkpoint.attempt,
        });
        try {
          this.afterReviewProviderCompletion?.();
        } catch (error) {
          throw new ReviewProviderCompletionInterruption(errorMessage(error));
        }
      },
      saveFailure: (failure) => this.store.appendEvent(runId, "provider.failure", failure),
      saveFallback: (fallback) => this.store.appendEvent(runId, "provider.fallback", fallback),
    }, this.store, runId);
    const supervisor = new ProviderSupervisor({
      adapters: candidates.map((candidate) => candidate.adapter),
      maxAttempts: (binding.runtimeConfiguration?.retryLimit ?? 1) + 1,
      persistence,
      authRecoveryCommand: `Authenticate the configured Reviewer, then run: agent-loop resume --run-id ${runId}`,
      unknownRecoveryCommand: `Inspect Reviewer artifacts, then run: agent-loop resume --run-id ${runId}`,
    });
    const supervised = new ReviewExecutor(supervisor);
    const verificationEvidence = this.reviewVerificationEvidence(runId, reviewedCommit);
    const reviewDirectory = resolve(this.loopHome, "runs", runId, "review", reviewedCommit);
    const reviewerCwd = binding.worktreePath;
    try {
      const result = await runReviewer(supervised, {
        task: binding.taskSpec,
        diff,
        reviewedCommit,
        diffHash,
        controlStateHash,
        verificationEvidence,
        allowedRepositoryRoots: [reviewerCwd],
        contextBudget: this.explorerContextBudget,
        lowRiskRubric: this.lowRiskRubric(binding),
      }, () => ({
        commit: git.head(),
        diffHash: hashReviewDiff(git.diffBetween(binding.baselineCommit, git.head())),
        controlStateHash: git.controlStateHash(),
        dirty: git.isDirty(),
      }), {
        invocationId: operation.id,
        cwd: reviewerCwd,
        maximumPromptBytes: binding.budget.maximumPromptBytes,
        artifactDirectory: resolve(reviewDirectory, "artifacts"),
        outputSchemaPath: this.roleOutputSchemas.reviewer,
        model: binding.runtimeConfiguration?.roleModels["reviewer"] ?? null,
      });
      const outcome = supervised.outcome;
      const selected = outcome?.selectedAdapterIndex === null || outcome?.selectedAdapterIndex === undefined
        ? null
        : candidates[outcome.selectedAdapterIndex] ?? null;
      if (outcome?.result) {
        this.installRoleInvocationManifest({
          runId,
          operation,
          role: "reviewer",
          renderedPrompt: result.renderedPrompt,
          outputSchemaPath: this.roleOutputSchemas.reviewer,
          actualProvider: outcome.result.identity,
          configuredProvider: selected,
          currentCommit: reviewedCommit,
          context: [
            { kind: "review-diff", reference: diffHash, content: diff, trust: "untrusted" },
            ...verificationEvidence.map((item) => ({
              kind: "verification-evidence",
              reference: item.evidenceId,
              content: item,
              trust: "trusted" as const,
            })),
          ],
        });
      }
      if (!result.report || !outcome?.result || !selected) {
        const providerBlock = {
          reason: "No configured independent Reviewer produced a valid structured report",
          supervisor: outcome,
        };
        this.store.appendEvent(runId, "review.provider-blocked", {
          operationId: operation.id,
          operationInputHash: operation.inputHash,
          ...providerBlock,
        });
        this.requireHumanReview(runId, "Independent review is unavailable", providerBlock, "provider-recovery");
        return;
      }
      this.store.recordAgentCall(runId, {
        role: "reviewer",
        provider: result.provider.identity.provider,
        latencyMs: result.provider.durationMs,
        usage: result.provider.usage,
      });
      const validatedReport = await this.validateReviewFindings(
        runId,
        operation,
        result.report,
        reviewedCommit,
        git,
      );
      const blockingFindings = validatedReport.findings.filter((finding) => isBlockingFinding(finding));
      const inconclusiveFindings = validatedReport.findings.filter((finding) =>
        finding.status === "proposed" && (finding.severity === "high" || finding.severity === "critical")
      );
      operation = this.store.finishOperation(operation.id, "succeeded", {
        report: validatedReport,
        blocking: blockingFindings.length > 0,
        blockingFindingIds: blockingFindings.map((finding) => finding.id),
        inconclusiveFindingIds: inconclusiveFindings.map((finding) => finding.id),
        reviewedCommit,
        diffHash,
        selectedReviewer: {
          configuredFamily: selected.family,
          configuredName: selected.name,
          observedIdentity: result.provider.identity,
        },
        supervisor: outcome,
      });
      if (!this.installSavedReviewEvidence(runId, operation, candidates)) {
        this.requireHumanReview(
          runId,
          "Completed independent review could not be bound to its configured Reviewer",
          { operationId: operation.id },
          operation.id,
        );
      } else if (inconclusiveFindings.length > 0) {
        this.requireFindingEvidence(runId, inconclusiveFindings, operation.id);
      }
    } catch (error) {
      if (error instanceof ReviewProviderCompletionInterruption) throw error;
      operation = this.store.finishOperation(operation.id, "failed", {
        reason: `Independent review or Finding validation failed closed: ${errorMessage(error)}`,
      });
      this.requireHumanReview(runId, "Independent review evidence check failed", operation.result, operation.id);
    }
  }

  private async executeVerification(runId: string): Promise<void> {
    const run = this.requireBoundRun(runId);
    const commands = this.projectAdapter.verificationCommands(run.binding.taskSpec);
    if (commands.length === 0) {
      this.block(runId, "No verification commands were configured", "verify");
      return;
    }
    const git = new GitService(run.binding.worktreePath, run.binding.budget);
    if (git.isDirty()) {
      this.block(runId, "Verification requires a clean Harness candidate", "verify");
      return;
    }
    await this.verifyCommands(runId, run.binding.worktreePath, commands, "verify");
  }

  private recoverWriterOperation(runId: string, operation: Operation, git: GitService): Operation {
    const run = this.requireBoundRun(runId);
    const input = writerOperationInput(operation.input);
    const completion = this.writerProviderReceipt(runId, operation.id);
    const durableOutput = completion?.result
      ? authorOutputSchema.safeParse(completion.result.finalOutput)
      : null;
    const output = durableOutput?.success
      ? durableOutput.data
      : this.readWriterOutput(runId, operation.kind as "author" | "repair", input.attempt);
    const completionReason = !completion
      ? "Writer recovery is missing a durable Provider completion receipt"
      : completion.invocationId !== operation.id || completion.operationInputHash !== operation.inputHash
        ? "Writer Provider completion receipt does not match the persisted operation"
        : !completion.ok
          ? "Writer Provider call completed unsuccessfully"
          : !output || completion.outputHash !== operationInputHash(output)
            ? "Writer Provider output does not match its durable completion receipt"
            : null;
    const reason = completionReason ?? writerBoundaryViolation(
      git,
      input.baseCommit,
      output !== null,
      input.gitControlHash,
    );
    if (reason || !output) {
      return this.store.finishOperation(operation.id, "failed", {
        reason: reason ?? "Writer recovery is missing valid structured output",
        providerCompletion: completion,
      });
    }
    if (completion?.result) {
      const failureEvidenceIds = isRecord(operation.input) && Array.isArray(operation.input.failureEvidenceIds)
        ? operation.input.failureEvidenceIds.filter((id): id is string => typeof id === "string")
        : [];
      const failureEvidence = this.store.listEvidence(runId).filter((item) => failureEvidenceIds.includes(item.id));
      const explorerReport = this.savedExplorerReport(runId);
      this.installRoleInvocationManifest({
        runId,
        operation,
        role: operation.kind as "author" | "repair",
        renderedPrompt: operation.kind === "author"
          ? authorPrompt(run.binding.taskSpec, explorerReport ? compactExplorerReport(explorerReport, run.binding.budget.maximumExplorerAdvisoryBytes) : null, { variant: run.binding.runtimeConfiguration?.promptVariant, memoryAdvisory: run.binding.memoryAdvisory })
          : repairPrompt(run.binding.taskSpec, input.attempt, input.baseCommit, failureEvidence, run.binding.budget),
        outputSchemaPath: this.roleOutputSchemas.author,
        actualProvider: completion.result.identity,
        configuredProvider: completion.configuredAuthor ?? null,
        currentCommit: input.baseCommit,
        context: [
          ...(explorerReport ? [{
            kind: "explorer-report",
            reference: `${runId}:explorer`,
            content: explorerReport,
            trust: "untrusted" as const,
          }] : []),
          ...failureEvidence.map((item) => ({
            kind: "failure-evidence",
            reference: item.id,
            content: item.data,
            trust: "trusted" as const,
          })),
        ],
      });
    }
    const recovered = this.store.finishOperation(operation.id, "succeeded", {
      recoveredAfterProviderCompletion: true,
      baseCommit: input.baseCommit,
      workingDiffHash: git.diffHash(),
      report: output,
      selectedAuthor: completion?.configuredAuthor ?? null,
      provider: completion?.result ?? null,
    });
    this.store.appendEvent(runId, `${operation.kind}.recovered`, {
      operationId: operation.id,
      workingDiffHash: git.diffHash(),
    });
    return recovered;
  }

  private writerProviderReceipt(runId: string, operationId: string): WriterProviderCompletion | null {
    const event = [...this.store.listEvents(runId)].reverse().find((item) =>
      item.type === "writer.provider-completed" &&
      isRecord(item.data) &&
      item.data.operationId === operationId
    );
    if (!event || !isRecord(event.data)) return null;
    const data = event.data;
    if (
      typeof data.operationId !== "string" ||
      typeof data.invocationId !== "string" ||
      !(typeof data.operationInputHash === "string" || data.operationInputHash === null) ||
      typeof data.ok !== "boolean" ||
      !(typeof data.exitCode === "number" || data.exitCode === null) ||
      !(typeof data.signal === "string" || data.signal === null) ||
      !(typeof data.failureClass === "string" || data.failureClass === null) ||
      typeof data.outputHash !== "string"
    ) return null;
    return data as unknown as WriterProviderCompletion;
  }

  private explorerProviderCompletion(runId: string, operationId: string): ExplorerProviderCompletion | null {
    const event = [...this.store.listEvents(runId)].reverse().find((item) =>
      item.type === "explorer.provider-completed" &&
      isRecord(item.data) &&
      item.data.operationId === operationId
    );
    if (!event || !isRecord(event.data)) return null;
    const data = event.data;
    const configuredExplorer = isRecord(data.configuredExplorer) ? data.configuredExplorer : null;
    const result = providerRunResultFromUnknown(data.result);
    if (
      typeof data.operationId !== "string" ||
      typeof data.operationInputHash !== "string" ||
      typeof data.selectedAdapterIndex !== "number" ||
      !Number.isSafeInteger(data.selectedAdapterIndex) ||
      data.selectedAdapterIndex < 0 ||
      typeof data.attempt !== "number" ||
      !Number.isSafeInteger(data.attempt) ||
      data.attempt <= 0 ||
      typeof configuredExplorer?.family !== "string" ||
      typeof configuredExplorer.name !== "string" ||
      !result
    ) return null;
    return {
      operationId: data.operationId,
      operationInputHash: data.operationInputHash,
      selectedAdapterIndex: data.selectedAdapterIndex,
      attempt: data.attempt,
      configuredExplorer: { family: configuredExplorer.family, name: configuredExplorer.name },
      result,
    };
  }

  private explorationEvidenceReceipt(
    runId: string,
    operation: Operation,
  ): { dependencies: ReturnType<typeof evidenceDependencies>; dependencyHash: string; stepId: string } {
    const run = this.requireBoundRun(runId);
    const stepId = "exploration";
    const dependencies = evidenceDependencies({
      commitSha: run.binding.baselineCommit,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operation.inputHash ?? operationInputHash(operation.input),
    });
    return { dependencies, dependencyHash: evidenceDependencyHash(dependencies), stepId };
  }

  private installExplorationEvidence(runId: string, operation: Operation): Evidence | null {
    const result = isRecord(operation.result) ? operation.result : null;
    const report = result ? explorerReportSchema.safeParse(result.report) : null;
    if (!report?.success) {
      this.block(runId, "Saved Explorer result cannot prove a valid bounded report", operation.id);
      return null;
    }
    const run = this.requireBoundRun(runId);
    const receipt = this.explorationEvidenceReceipt(runId, operation);
    return this.store.installEvidence({
      id: `${runId}:evidence:exploration:${receipt.dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "exploration",
      commitSha: run.binding.baselineCommit,
      policyVersion: run.binding.policyVersion,
      stepId: receipt.stepId,
      dependencyHash: receipt.dependencyHash,
      dependencies: receipt.dependencies,
      data: { report: report.data, result: operation.result },
    });
  }

  private acceptanceEvidenceReceipt(runId: string, commitSha: string): {
    operationId: string;
    operationInput: unknown;
    dependencies: ReturnType<typeof evidenceDependencies>;
    dependencyHash: string;
    stepId: string;
  } {
    const run = this.requireBoundRun(runId);
    const stepId = "acceptance-binding";
    const operationId = `${runId}:acceptance-binding:${commitSha}`;
    const operationInput = {
      role: "acceptance-binding",
      commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
    };
    const dependencies = evidenceDependencies({
      commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operationInputHash(operationInput),
    });
    return { operationId, operationInput, dependencies, dependencyHash: evidenceDependencyHash(dependencies), stepId };
  }

  private safeReviewCandidates(runId: string): ConfiguredProvider[] {
    return this.providerProfile
      ? independentReviewCandidates(this.providerProfile, this.actualAuthor(runId) ?? this.providerProfile.author)
      : [];
  }

  private actualAuthor(runId: string): ConfiguredProvider | null {
    if (!this.providerProfile) return null;
    const configured = [this.providerProfile.author, this.providerProfile.fallbackAuthor];
    const writer = [...this.store.listOperations(runId)].reverse().find((operation) =>
      (operation.kind === "author" || operation.kind === "repair") && operation.status === "succeeded"
    );
    const selected = writer && isRecord(writer.result) && isRecord(writer.result.selectedAuthor)
      ? writer.result.selectedAuthor
      : null;
    if (!selected) return this.providerProfile.author;
    return configured.find((candidate) =>
      candidate.family === selected.family && candidate.name === selected.name
    ) ?? null;
  }

  private reviewOperationId(runId: string, commitSha: string, operationInput: unknown): string {
    return `${runId}:independent-review:${commitSha}:${operationInputHash(operationInput).slice(0, 16)}`;
  }

  private reviewOperationInput(
    runId: string,
    reviewedCommit: string,
    diffHash: string,
    controlStateHash: string,
    candidates: readonly ConfiguredProvider[],
  ): unknown {
    const run = this.requireBoundRun(runId);
    return {
      role: "independent-review",
      baselineCommit: run.binding.baselineCommit,
      reviewedCommit,
      diffHash,
      controlStateHash,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      verificationDependencyHashes: this.store.listEvidence(runId, "valid")
        .filter((item) => item.kind === "command" && item.commitSha === reviewedCommit && item.stepId.startsWith("verify:"))
        .map((item) => item.dependencyHash)
        .sort(),
      configuredAuthor: this.actualAuthor(runId) ? configuredProviderFact(this.actualAuthor(runId)!) : null,
      configuredReviewers: candidates.map(configuredProviderFact),
    };
  }

  private reviewEvidenceReceipt(
    runId: string,
    commitSha: string,
    operationInput: unknown,
    reviewer: ConfiguredProvider,
  ): {
    dependencies: ReturnType<typeof evidenceDependencies>;
    dependencyHash: string;
    stepId: string;
  } {
    const run = this.requireBoundRun(runId);
    const stepId = `independent-review:${reviewer.family}:${reviewer.name}`;
    const dependencies = evidenceDependencies({
      commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operationInputHash(operationInput),
    });
    return { dependencies, dependencyHash: evidenceDependencyHash(dependencies), stepId };
  }

  private matchesReviewEvidence(
    runId: string,
    evidence: Evidence,
    reviewer: ConfiguredProvider,
    operation: Operation,
    currentInput: unknown,
  ): boolean {
    if (
      operation.status !== "succeeded" ||
      evidence.operationId !== operation.id ||
      operationInputHash(operation.input) !== operationInputHash(currentInput) ||
      !isRecord(evidence.data)
    ) return false;
    const selected = isRecord(evidence.data.selectedReviewer) ? evidence.data.selectedReviewer : null;
    if (
      selected?.configuredFamily !== reviewer.family ||
      selected.configuredName !== reviewer.name
    ) return false;
    const receipt = this.reviewEvidenceReceipt(runId, evidence.commitSha, operation.input, reviewer);
    return evidence.dependencyHash === receipt.dependencyHash;
  }

  private installSavedReviewEvidence(
    runId: string,
    operation: Operation,
    candidates: readonly ConfiguredProvider[],
  ): Evidence | null {
    if (operation.status !== "succeeded" || !isRecord(operation.result)) return null;
    const selectedFact = isRecord(operation.result.selectedReviewer) ? operation.result.selectedReviewer : null;
    const selected = candidates.find((candidate) =>
      candidate.family === selectedFact?.configuredFamily && candidate.name === selectedFact.configuredName
    );
    const report = reviewReportSchema.safeParse(operation.result.report);
    const reviewedCommit = operation.result.reviewedCommit;
    const diffHash = operation.result.diffHash;
    if (!selected || !report.success || typeof reviewedCommit !== "string" || typeof diffHash !== "string") return null;
    const run = this.requireBoundRun(runId);
    const expectedInput = this.reviewOperationInput(
      runId,
      reviewedCommit,
      diffHash,
      new GitService(run.binding.worktreePath, run.binding.budget).controlStateHash(),
      candidates,
    );
    if (operationInputHash(operation.input) !== operationInputHash(expectedInput)) return null;
    const receipt = this.reviewEvidenceReceipt(runId, reviewedCommit, operation.input, selected);
    return this.store.installEvidenceReplacingKinds({
      id: `${runId}:evidence:review:${receipt.dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "independent_review",
      commitSha: reviewedCommit,
      policyVersion: this.requireBoundRun(runId).binding.policyVersion,
      stepId: receipt.stepId,
      dependencyHash: receipt.dependencyHash,
      dependencies: receipt.dependencies,
      data: {
        report: report.data,
        blocking: operation.result.blocking === true,
        blockingFindingIds: operation.result.blockingFindingIds,
        reviewedCommit,
        diffHash,
        selectedReviewer: selectedFact,
      },
    }, ["independent_review"]);
  }

  private reviewVerificationEvidence(runId: string, commitSha: string): VerificationEvidence[] {
    return this.store.listEvidence(runId, "valid").flatMap((item) => {
      if (item.kind !== "command" || item.commitSha !== commitSha || !item.stepId.startsWith("verify:") || !isRecord(item.data)) {
        return [];
      }
      if (!Array.isArray(item.data.argv) || item.data.argv.some((part) => typeof part !== "string") || item.data.exitCode !== 0) {
        return [];
      }
      return [{ evidenceId: item.id, command: item.data.argv as string[], exitCode: 0, commitSha, result: "passed" }];
    });
  }

  private async validateReviewFindings(
    runId: string,
    reviewOperation: Operation,
    report: ReviewReport,
    reviewedCommit: string,
    git: GitService,
  ): Promise<ReviewReport> {
    const findings: Finding[] = [];
    for (const finding of report.findings) {
      findings.push(await this.validateFinding(runId, reviewOperation, finding, reviewedCommit, git));
    }
    return reviewReportSchema.parse({ findings });
  }

  private async validateFinding(
    runId: string,
    reviewOperation: Operation,
    finding: Finding,
    reviewedCommit: string,
    git: GitService,
  ): Promise<Finding> {
    const run = this.requireBoundRun(runId);
    const input = {
      role: "finding-validation",
      reviewOperationId: reviewOperation.id,
      reviewedCommit,
      findingId: finding.id,
      claimHash: findingClaimHash(finding),
      validationPolicy: "project-adapter-plan/v1",
      projectAdapter: {
        name: this.projectAdapter.name,
        policyVersion: this.projectAdapter.policyVersion,
      },
      verificationRequest: finding.verificationRequest,
      evidenceIds: finding.evidenceIds,
    };
    const inputHash = operationInputHash(input);
    const operationId = `${reviewOperation.id}:finding-validation:${inputHash.slice(0, 16)}`;
    let operation = this.store.createOperation({
      id: operationId,
      runId,
      kind: "finding-validation",
      idempotencyKey: operationId,
      input,
    });
    if (operation.status === "failed") {
      throw new Error(`Finding validation previously failed: ${finding.id}`);
    }
    if (operation.status === "running") {
      try {
        const result = await new FindingValidator(this.projectAdapter, this.commandRunner).validate({
          finding,
          reviewedCommit,
          task: run.binding.taskSpec,
          worktreePath: run.binding.worktreePath,
          artifactDirectory: resolve(
            this.loopHome,
            "runs",
            runId,
            "review",
            reviewedCommit,
            "finding-validation",
            inputHash.slice(0, 16),
          ),
          evidence: this.store.listEvidence(runId, "valid"),
          git,
        });
        operation = this.store.finishOperation(operation.id, "succeeded", result);
      } catch (error) {
        operation = this.store.finishOperation(operation.id, "failed", { reason: errorMessage(error) });
        throw error;
      }
    }
    if (!isBoundFindingValidationDecision(operation.result, {
      findingId: finding.id,
      claimHash: input.claimHash,
      reviewedCommit,
    })) {
      throw new Error(`Finding validation result is invalid: ${finding.id}`);
    }
    const result: FindingValidationDecision = operation.result;
    const stepId = `finding-validation:${finding.id}`;
    const dependencies = evidenceDependencies({
      commitSha: reviewedCommit,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operation.inputHash ?? inputHash,
    });
    const dependencyHash = evidenceDependencyHash(dependencies);
    this.store.installEvidence({
      id: `${runId}:evidence:finding-validation:${dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "finding_validation",
      commitSha: reviewedCommit,
      policyVersion: run.binding.policyVersion,
      stepId,
      dependencyHash,
      dependencies,
      data: result,
    });
    return { ...finding, status: result.status === "inconclusive" ? "proposed" : result.status };
  }

  private reviewProviderCompletion(runId: string, operationId: string): ReviewProviderCompletion | null {
    const event = [...this.store.listEvents(runId)].reverse().find((item) =>
      item.type === "review.provider-completed" &&
      isRecord(item.data) &&
      item.data.operationId === operationId
    );
    if (!event || !isRecord(event.data)) return null;
    const data = event.data;
    const configuredReviewer = isRecord(data.configuredReviewer) ? data.configuredReviewer : null;
    const result = providerRunResultFromUnknown(data.result);
    if (
      typeof data.operationId !== "string" ||
      typeof data.operationInputHash !== "string" ||
      typeof data.selectedAdapterIndex !== "number" ||
      !Number.isSafeInteger(data.selectedAdapterIndex) ||
      data.selectedAdapterIndex < 0 ||
      typeof data.attempt !== "number" ||
      !Number.isSafeInteger(data.attempt) ||
      data.attempt <= 0 ||
      typeof configuredReviewer?.family !== "string" ||
      typeof configuredReviewer.name !== "string" ||
      !result
    ) return null;
    return {
      operationId: data.operationId,
      operationInputHash: data.operationInputHash,
      selectedAdapterIndex: data.selectedAdapterIndex,
      attempt: data.attempt,
      configuredReviewer: { family: configuredReviewer.family, name: configuredReviewer.name },
      result,
    };
  }

  private async recoverReviewOperation(
    runId: string,
    operation: Operation,
    candidates: readonly ConfiguredProvider[],
    completion: ReviewProviderCompletion,
  ): Promise<void> {
    const run = this.requireBoundRun(runId);
    const input = reviewOperationData(operation.input);
    const selected = candidates[completion.selectedAdapterIndex];
    const git = new GitService(run.binding.worktreePath, run.binding.budget);
    const currentDiffHash = hashReviewDiff(git.diffBetween(run.binding.baselineCommit, git.head()));
    const boundaryViolation =
      completion.operationInputHash !== operation.inputHash ||
      completion.operationId !== operation.id ||
      !selected ||
      selected.family !== completion.configuredReviewer.family ||
      selected.name !== completion.configuredReviewer.name ||
      git.isDirty() ||
      git.head() !== input.reviewedCommit ||
      currentDiffHash !== input.diffHash ||
      git.controlStateHash() !== input.controlStateHash;
    const report = boundaryViolation ? null : reviewReportFromProvider(completion.result, input.reviewedCommit);
    if (boundaryViolation || !report) {
      const failed = this.store.finishOperation(operation.id, "failed", {
        reason: boundaryViolation
          ? "Recovered Reviewer completion no longer matches the bound Git or Provider configuration"
          : "Recovered Reviewer completion has invalid structured output",
        providerCompletion: completion,
      });
      this.requireHumanReview(runId, "Independent Reviewer recovery failed closed", failed.result, failed.id);
      return;
    }
    const diff = git.diffBetween(run.binding.baselineCommit, git.head());
    const verificationEvidence = this.reviewVerificationEvidence(runId, input.reviewedCommit);
    this.installRoleInvocationManifest({
      runId,
      operation,
      role: "reviewer",
      renderedPrompt: renderReviewerPrompt({
        task: run.binding.taskSpec,
        diff,
        reviewedCommit: input.reviewedCommit,
        diffHash: input.diffHash,
        controlStateHash: input.controlStateHash,
        verificationEvidence,
        allowedRepositoryRoots: [run.binding.worktreePath],
        contextBudget: this.explorerContextBudget,
        lowRiskRubric: this.lowRiskRubric(run.binding),
      }),
      outputSchemaPath: this.roleOutputSchemas.reviewer,
      actualProvider: completion.result.identity,
      configuredProvider: selected,
      currentCommit: input.reviewedCommit,
      context: [
        { kind: "review-diff", reference: input.diffHash, content: diff, trust: "untrusted" },
        ...verificationEvidence.map((item) => ({
          kind: "verification-evidence",
          reference: item.evidenceId,
          content: item,
          trust: "trusted" as const,
        })),
      ],
    });
    this.store.recordAgentCall(runId, {
      role: "reviewer",
      provider: completion.result.identity.provider,
      latencyMs: completion.result.durationMs,
      usage: completion.result.usage,
    });
    const validatedReport = await this.validateReviewFindings(
      runId,
      operation,
      report,
      input.reviewedCommit,
      git,
    );
    const blockingFindings = validatedReport.findings.filter((finding) => isBlockingFinding(finding));
    const inconclusiveFindings = validatedReport.findings.filter((finding) =>
      finding.status === "proposed" && (finding.severity === "high" || finding.severity === "critical")
    );
    const completed = this.store.finishOperation(operation.id, "succeeded", {
      report: validatedReport,
      blocking: blockingFindings.length > 0,
      blockingFindingIds: blockingFindings.map((finding) => finding.id),
      inconclusiveFindingIds: inconclusiveFindings.map((finding) => finding.id),
      reviewedCommit: input.reviewedCommit,
      diffHash: input.diffHash,
      selectedReviewer: {
        configuredFamily: selected.family,
        configuredName: selected.name,
        observedIdentity: completion.result.identity,
      },
      recoveredAfterProviderCompletion: true,
      providerCompletion: completion,
    });
    if (!this.installSavedReviewEvidence(runId, completed, candidates)) {
      this.requireHumanReview(
        runId,
        "Recovered independent review could not be bound to Evidence",
        { operationId: completed.id },
        completed.id,
      );
    } else if (inconclusiveFindings.length > 0) {
      this.requireFindingEvidence(runId, inconclusiveFindings, completed.id);
    }
  }

  private requireFindingEvidence(runId: string, findings: readonly Finding[], checkpointRef: string): void {
    const reason = "High-risk Reviewer Findings need human evidence because no approved machine predicate confirmed or rejected them";
    const question = `${reason}. How should these Findings be handled?`;
    if (!this.store.listHumanInbox(runId).some((item) => item.question === question)) {
      this.store.createHumanInbox(runId, {
        question,
        options: ["inspect-finding-evidence", "add-project-verification-step", "cancel"],
        recommendation: "add-project-verification-step",
        evidence: {
          findings: findings.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            claim: finding.claim,
            proposedVerification: finding.proposedVerification,
          })),
        },
        risk: "high",
        consequence: "The Harness will not silently convert an unverified model claim into a machine conclusion",
        resumeCommand: `agent-loop resume --run-id ${runId}`,
      });
    }
    this.block(runId, reason, checkpointRef);
  }

  private requireHumanReview(
    runId: string,
    reason: string,
    evidence: unknown,
    checkpointRef: string,
    recovery?: RecoveryDisposition,
  ): void {
    const question = `${reason}. How should this Run proceed?`;
    if (!this.store.listHumanInbox(runId).some((item) => item.question === question)) {
      this.store.createHumanInbox(runId, {
        question,
        options: ["configure-independent-reviewer", "inspect-evidence", "cancel"],
        recommendation: "configure-independent-reviewer",
        evidence,
        risk: "high",
        consequence: "The Harness will not mark this candidate ready without the required independent proof",
        resumeCommand: `agent-loop resume --run-id ${runId}`,
      });
    }
    this.block(runId, reason, checkpointRef, recovery);
  }

  private reconcileCommitBoundEvidence(runId: string, currentCommit: string): void {
    const kinds = [
      "candidate_commit",
      "command",
      "verification_failure",
      "finding_validation",
      "independent_review",
      "acceptance_binding",
      "commit_policy",
    ];
    const currentHashes = this.store.listEvidence(runId, "valid")
      .filter((item) => kinds.includes(item.kind) && item.commitSha === currentCommit)
      .map((item) => item.dependencyHash);
    this.store.invalidateEvidenceOfKindsExcept(runId, kinds, currentHashes);
  }

  private readWriterOutput(
    runId: string,
    role: "author" | "repair",
    attempt: number,
  ): ReturnType<typeof authorOutputSchema.parse> | null {
    const path = resolve(this.writerArtifactDirectory(runId, role, attempt), "final.json");
    try {
      return existsSync(path) ? authorOutputSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
    } catch {
      return null;
    }
  }

  private writerArtifactDirectory(runId: string, role: "author" | "repair", attempt: number): string {
    return role === "author"
      ? resolve(this.loopHome, "runs", runId, "author")
      : resolve(this.loopHome, "runs", runId, "repair", String(attempt));
  }

  // low-risk-review-rubric target: the rubric only shapes reviews of runs
  // whose frozen effective risk is low (reachable via --template escalation);
  // normal/high reviews keep the unmodified reviewer contract.
  private lowRiskRubric(binding: RunBinding): string | null {
    if (binding.risk !== "low") return null;
    return binding.runtimeConfiguration?.lowRiskReviewRubric ?? null;
  }

  private installRoleInvocationManifest(input: {
    runId: string;
    operation: Operation;
    role: InvocationRole;
    renderedPrompt: string;
    outputSchemaPath: string;
    actualProvider: ProviderRunResult["identity"];
    configuredProvider: Pick<ConfiguredProvider, "name"> | null;
    currentCommit: string;
    context?: readonly ManifestContextInput[];
  }): void {
    const run = this.requireBoundRun(input.runId);
    this.store.installInvocationManifest(createInvocationManifest({
      id: `${input.operation.id}:manifest:v1`,
      runId: input.runId,
      operationId: input.operation.id,
      role: input.role,
      binding: run.binding,
      renderedPrompt: input.renderedPrompt,
      outputSchemaPath: input.outputSchemaPath,
      configuredProvider: {
        provider: input.configuredProvider?.name ?? this.providerProfileName,
        model: null,
      },
      actualProvider: input.actualProvider,
      currentCommit: input.currentCommit,
      verificationPlan: this.projectAdapter.verificationCommands(run.binding.taskSpec),
      context: this.orderManifestContext(run.binding, [
        {
          kind: "task-spec",
          reference: run.binding.taskSpecPath,
          content: run.binding.taskSpec,
          trust: "project",
        },
        ...(input.context ?? []),
      ]),
      createdAt: input.operation.startedAt,
    }));
  }

  private orderManifestContext(
    binding: RunBinding,
    context: readonly ManifestContextInput[],
  ): ManifestContextInput[] {
    const ranking = binding.runtimeConfiguration?.contextRanking;
    if (!ranking) return [...context];
    return [...context].sort((left, right) => {
      const leftRank = ranking.findIndex((value) => left.kind.includes(value));
      const rightRank = ranking.findIndex((value) => right.kind.includes(value));
      return (leftRank < 0 ? ranking.length : leftRank) - (rightRank < 0 ? ranking.length : rightRank);
    });
  }

  private orderProviderCandidates(binding: RunBinding, candidates: readonly ConfiguredProvider[]): ConfiguredProvider[] {
    const order = binding.runtimeConfiguration?.providerOrder;
    if (!order) return [...candidates];
    return [...candidates].sort((left, right) => providerRank(left, order) - providerRank(right, order));
  }

  private savedExplorerReport(runId: string): ExplorerReport | null {
    const result = this.store.listOperations(runId).find((operation) => operation.kind === "explorer")?.result;
    const parsed = isRecord(result) ? explorerReportSchema.safeParse(result.report) : null;
    return parsed?.success ? parsed.data : null;
  }

  private failureCheckpoint(runId: string): string {
    const operations = this.store.listOperations(runId);
    const failed = [...operations].reverse().find((operation) => operation.status === "failed");
    if (failed) return failed.id;
    const evidence = [...this.store.listEvidence(runId)].reverse().find((item) =>
      item.kind === "verification_failure"
    );
    return evidence?.operationId ?? "proof-gap";
  }

  private durableBlockReason(runId: string, fallback: string): string {
    const failed = [...this.store.listOperations(runId)].reverse().find((operation) => operation.status === "failed");
    return failed && isRecord(failed.result) && typeof failed.result.reason === "string"
      ? failed.result.reason
      : fallback;
  }

  private async completeMergedRun(runId: string, task: ReturnType<typeof loadTaskSpec>): Promise<RunView> {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "merged" || !run.mergeSha) throw new Error(`Run ${runId} is not merged`);
    const mergedEvent = [...this.store.listEvents(runId)].reverse().find((event) => event.type === "run.merged");
    const repository = isRecord(mergedEvent?.data) && typeof mergedEvent.data.repository === "string"
      ? mergedEvent.data.repository
      : null;
    if (!repository || !existsSync(repository)) {
      this.block(runId, "Merged repository is unavailable for post-merge checks", "post-merge");
      return this.status(runId);
    }
    const git = new GitService(repository);
    if (git.head() !== run.mergeSha || git.isDirty()) {
      this.block(runId, "Merged repository HEAD or dirty state no longer matches the recorded merge", "post-merge");
      return this.status(runId);
    }
    const commands = this.projectAdapter.postMergeCommands(task);
    if (commands.length === 0) {
      this.block(runId, "No post-merge checks were configured", "post-merge");
      return this.status(runId);
    }
    if (await this.verifyCommands(runId, repository, commands, "post-merge")) {
      this.store.transitionRun(runId, "done", {}, { mergeSha: run.mergeSha });
    }
    return this.status(runId);
  }

  private async verifyCommands(
    runId: string,
    worktreePath: string,
    commands: readonly VerificationCommand[],
    phase: "verify" | "post-merge",
  ): Promise<boolean> {
    const commitSha = new GitService(worktreePath).head();
    for (const command of commands) {
      const stepId = `${phase}:${command.id}`;
      const receipt = this.commandEvidenceReceipt(runId, commitSha, worktreePath, phase, command);
      const dependencyHash = receipt.dependencyHash;
      const existingEvidence = this.store
        .listEvidence(runId, "valid")
        .find((item) => item.dependencyHash === dependencyHash);
      if (existingEvidence) continue;
      const operation = this.store.createOperation({
        id: `${runId}:${phase}:${command.id}:${dependencyHash.slice(0, 12)}`,
        runId,
        kind: `${phase}:${command.id}`,
        idempotencyKey: `${runId}:${phase}:${dependencyHash}`,
        input: receipt.operationInput,
      });
      if (operation.status === "succeeded") {
        if (isSuccessfulCommandResult(operation.result, commitSha, command.argv)) {
          this.store.installEvidence({
            id: `${runId}:evidence:${phase}:${command.id}:${dependencyHash.slice(0, 12)}`,
            runId,
            operationId: operation.id,
            kind: "command",
            commitSha,
            policyVersion: this.projectAdapter.policyVersion,
            stepId,
            dependencyHash,
            dependencies: receipt.dependencies,
            data: operation.result,
          });
          continue;
        }
        this.block(runId, `Saved result for ${stepId} cannot prove success at the current commit`, operation.id);
        return false;
      }
      if (operation.status === "failed") {
        if (phase === "verify" && isCommandFailureResult(operation.result)) {
          this.installVerificationFailure(runId, operation, command, commitSha, receipt.operationInput);
        } else {
          this.block(runId, `Previous ${stepId} operation failed`, operation.id);
        }
        return false;
      }
      let result;
      try {
        result = await this.commandRunner.run({
          argv: command.argv,
          cwd: worktreePath,
          artifactDirectory: resolve(this.loopHome, "runs", runId, phase, command.id),
          environmentAllowlist: commandEnvironmentAllowlist(),
          timeoutMs: this.requireBoundRun(runId).binding.runtimeConfiguration?.timeoutMs ?? 10 * 60_000,
          outputLimitBytes: 1024 * 1024,
        });
      } catch (error) {
        this.store.finishOperation(operation.id, "failed", { error: errorMessage(error) });
        this.block(runId, `Verification ${command.id} could not run: ${errorMessage(error)}`, operation.id);
        return false;
      }
      const succeeded = isSuccessfulCommandResult(result, commitSha, command.argv);
      this.store.finishOperation(operation.id, succeeded ? "succeeded" : "failed", result);
      if (!succeeded) {
        if (phase === "verify") {
          this.installVerificationFailure(runId, operation, command, commitSha, receipt.operationInput, result);
        } else {
          this.block(
            runId,
            `Post-merge verification ${command.id} failed or produced an invalid process receipt`,
            operation.id,
          );
        }
        return false;
      }
      this.store.installEvidence({
        id: `${runId}:evidence:${phase}:${command.id}:${dependencyHash.slice(0, 12)}`,
        runId,
        operationId: operation.id,
        kind: "command",
        commitSha,
        policyVersion: this.projectAdapter.policyVersion,
        stepId,
        dependencyHash,
        dependencies: receipt.dependencies,
        data: result,
      });
    }
    return true;
  }

  private installVerificationFailure(
    runId: string,
    operation: Operation,
    command: VerificationCommand,
    commitSha: string,
    operationInput: unknown,
    suppliedResult?: unknown,
  ): Evidence {
    const run = this.requireBoundRun(runId);
    const result = suppliedResult ?? operation.result;
    const stderr = commandArtifactText(result, "stderrPath");
    const stdout = commandArtifactText(result, "stdoutPath");
    // The signature normalizes declared noise classes (timestamps, PIDs,
    // temp paths, hex ids, durations) so the same root cause is recognized
    // across reruns; the raw stderr/stdout stay untouched in the evidence.
    const signature = operationInputHash({
      commandId: command.id,
      exitCode: isRecord(result) ? result.exitCode : null,
      signal: isRecord(result) ? result.signal : null,
      timedOut: isRecord(result) ? result.timedOut : null,
      stderr: normalizeFailureText(stderr),
      stdout: normalizeFailureText(stdout),
    });
    const stepId = `verification-failure:${command.id}`;
    const dependencies = evidenceDependencies({
      commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operationInputHash(operationInput),
    });
    const dependencyHash = evidenceDependencyHash(dependencies);
    const evidence = this.store.installEvidence({
      id: `${runId}:evidence:failure:${command.id}:${dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "verification_failure",
      commitSha,
      policyVersion: run.binding.policyVersion,
      stepId,
      dependencyHash,
      dependencies,
      data: {
        signature,
        commandId: command.id,
        argv: [...command.argv],
        result,
        stderr,
        stdout,
      },
    });
    this.afterVerificationFailure?.();
    return evidence;
  }

  private ensureCandidateCommit(
    runId: string,
    git: GitService,
    writerOperationId: string,
    attempt: number,
    baseCommit = this.requireBoundRun(runId).binding.baselineCommit,
  ): CandidateCommit | null {
    const run = this.requireBoundRun(runId);
    const operationId = `${runId}:checkpoint-commit:${attempt}`;
    let operation = this.store.getOperation(operationId);
    if (!operation) {
      if (git.head() !== baseCommit || !git.isDirty() || git.hasStagedChanges()) {
        this.block(runId, "Harness cannot plan a candidate commit from the current Git state", writerOperationId);
        return null;
      }
      const input = {
        role: "checkpoint-commit",
        attempt,
        writerOperationId,
        baseCommit,
        workingDiffHash: git.diffHash(),
        message: `agent-loop(${run.taskId}): checkpoint ${attempt}`,
      };
      operation = this.store.createOperation({
        id: operationId,
        runId,
        kind: "checkpoint-commit",
        idempotencyKey: operationId,
        input,
      });
    }

    if (operation.status === "failed") {
      this.block(runId, "Harness candidate commit previously failed", operation.id);
      return null;
    }
    const input = candidateOperationInput(operation.input);
    let candidate: CandidateCommit;
    if (operation.status === "running") {
      if (git.head() === input.baseCommit) {
        if (!git.isDirty() || git.hasStagedChanges() || git.diffHash() !== input.workingDiffHash) {
          this.store.finishOperation(operation.id, "failed", {
            reason: "Working diff changed after the Harness planned its candidate commit",
          });
          this.block(runId, "Working diff changed before the Harness commit", operation.id);
          return null;
        }
        candidate = git.commitCandidate({ baseCommit: input.baseCommit, message: input.message });
        this.store.appendEvent(runId, "candidate-commit.created", {
          operationId: operation.id,
          candidate,
        });
        this.afterHarnessCommit?.();
      } else {
        const receipt = this.candidateCommitReceipt(runId, operation.id);
        if (
          !receipt ||
          git.isDirty() ||
          git.head() !== receipt.commitSha ||
          git.parent() !== input.baseCommit ||
          receipt.baseCommit !== input.baseCommit ||
          receipt.message !== input.message ||
          receipt.diffHash !== git.diffHashBetween(input.baseCommit) ||
          receipt.authorName !== "Agent Loop Harness" ||
          receipt.authorEmail !== "agent-loop@localhost"
        ) {
          this.store.finishOperation(operation.id, "failed", {
            reason: "Cannot recover the exact durable Harness-owned candidate commit",
            currentHead: git.head(),
          });
          this.block(runId, "Candidate commit recovery is ambiguous", operation.id);
          return null;
        }
        candidate = receipt;
        this.store.appendEvent(runId, "candidate-commit.recovered", {
          operationId: operation.id,
          commitSha: candidate.commitSha,
        });
      }
      operation = this.store.finishOperation(operation.id, "succeeded", candidate);
    } else {
      candidate = candidateCommitResult(operation.result);
      if (git.isDirty() || git.head() !== candidate.commitSha || git.parent() !== candidate.baseCommit) {
        this.store.invalidateAllEvidence(runId);
        this.block(runId, "Saved candidate commit no longer matches the worktree", operation.id);
        return null;
      }
    }

    const operationInput = operation.input;
    const changedFiles = git.changedFilesBetween(
      this.requireBoundRun(runId).binding.baselineCommit,
      candidate.commitSha,
    );
    const riskFloor = this.projectAdapter.minimumRisk({
      task: this.requireBoundRun(runId).binding.taskSpec,
      changedFiles,
    });
    this.store.escalateRunRisk(runId, riskFloor, {
      changedFiles,
      candidateCommit: candidate.commitSha,
    });
    const effectiveRun = this.requireBoundRun(runId);
    const stepId = `candidate-commit:${attempt}`;
    const dependencies = evidenceDependencies({
      commitSha: candidate.commitSha,
      taskSpecHash: effectiveRun.binding.taskSpecHash,
      acceptanceHash: effectiveRun.binding.acceptanceHash,
      policyVersion: effectiveRun.binding.policyVersion,
      stepId,
      operationInputHash: operationInputHash(operationInput),
    });
    const dependencyHash = evidenceDependencyHash(dependencies);
    this.store.installEvidenceReplacingKinds({
      id: `${runId}:evidence:candidate:${dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "candidate_commit",
      commitSha: candidate.commitSha,
      policyVersion: effectiveRun.binding.policyVersion,
      stepId,
      dependencyHash,
      dependencies,
      data: candidate,
    }, ["candidate_commit", "command", "verification_failure", "finding_validation", "independent_review", "acceptance_binding", "commit_policy"]);
    const commitPolicyStepId = `commit-policy:${attempt}`;
    const commitPolicyData = {
      hooks_skipped: true,
      replacement_verification_steps: effectiveRun.binding.taskSpec.verification.map((command) => command.id),
    };
    const commitPolicyDependencies = evidenceDependencies({
      commitSha: candidate.commitSha,
      taskSpecHash: effectiveRun.binding.taskSpecHash,
      acceptanceHash: effectiveRun.binding.acceptanceHash,
      policyVersion: effectiveRun.binding.policyVersion,
      stepId: commitPolicyStepId,
      operationInputHash: operationInputHash(commitPolicyData),
    });
    const commitPolicyHash = evidenceDependencyHash(commitPolicyDependencies);
    this.store.installEvidence({
      id: `${runId}:evidence:commit-policy:${commitPolicyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "commit_policy",
      commitSha: candidate.commitSha,
      policyVersion: effectiveRun.binding.policyVersion,
      stepId: commitPolicyStepId,
      dependencyHash: commitPolicyHash,
      dependencies: commitPolicyDependencies,
      data: commitPolicyData,
    });
    return candidate;
  }

  private candidateCommitReceipt(runId: string, operationId: string): CandidateCommit | null {
    const event = [...this.store.listEvents(runId)].reverse().find((item) =>
      item.type === "candidate-commit.created" &&
      isRecord(item.data) &&
      item.data.operationId === operationId
    );
    if (!event || !isRecord(event.data)) return null;
    try {
      return candidateCommitResult(event.data.candidate);
    } catch {
      return null;
    }
  }

  private commandEvidenceReceipt(
    runId: string,
    commitSha: string,
    cwd: string,
    phase: "verify" | "post-merge",
    command: VerificationCommand,
  ): {
    operationInput: unknown;
    dependencies: ReturnType<typeof evidenceDependencies>;
    dependencyHash: string;
  } {
    const run = this.requireBoundRun(runId);
    const operationInput = {
      kind: "command",
      phase,
      commandId: command.id,
      argv: [...command.argv],
      cwd: resolve(cwd),
    };
    const dependencies = evidenceDependencies({
      commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId: `${phase}:${command.id}`,
      operationInputHash: operationInputHash(operationInput),
    });
    return { operationInput, dependencies, dependencyHash: evidenceDependencyHash(dependencies) };
  }

  private loadBoundTask(
    runId: string,
    legacyTaskPath?: string,
  ): ReturnType<typeof loadTaskSpec> | null {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.binding) {
      this.store.invalidateAllEvidence(runId);
      this.block(runId, "Run predates immutable task binding; start a new run", "run-binding");
      return null;
    }

    const mismatches: string[] = [];
    if (run.binding.projectAdapterName !== this.projectAdapter.name) mismatches.push("project adapter");
    if (run.binding.policyVersion !== this.projectAdapter.policyVersion) mismatches.push("policy version");
    if (run.binding.providerProfile !== this.providerProfileName) mismatches.push("provider profile");
    if (taskSpecHash(run.binding.taskSpec) !== run.binding.taskSpecHash) mismatches.push("task snapshot");
    if (acceptanceHash(run.binding.taskSpec.acceptance) !== run.binding.acceptanceHash) {
      mismatches.push("acceptance snapshot");
    }

    const pathToCheck = legacyTaskPath ? resolve(legacyTaskPath) : run.binding.taskSpecPath;
    if (legacyTaskPath) {
      if (!existsSync(pathToCheck) || normalizedExistingPath(pathToCheck) !== run.binding.taskSpecPath) {
        mismatches.push("task path");
      }
    }
    if (existsSync(pathToCheck)) {
      try {
        if (taskSpecHash(loadTaskSpec(pathToCheck)) !== run.binding.taskSpecHash) {
          mismatches.push("task spec");
        }
      } catch {
        mismatches.push("task spec");
      }
    }

    if (mismatches.length > 0) {
      this.store.invalidateAllEvidence(runId);
      this.block(
        runId,
        `Immutable run binding mismatch: ${[...new Set(mismatches)].join(", ")}`,
        "run-binding",
      );
      return null;
    }
    return run.binding.taskSpec;
  }

  private requireBoundRun(runId: string): Run & { binding: NonNullable<Run["binding"]> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.binding) throw new Error(`Run ${runId} has no immutable binding`);
    return run as Run & { binding: NonNullable<Run["binding"]> };
  }

  private block(runId: string, reason: string, checkpointRef: string, recovery?: RecoveryDisposition): void {
    const current = this.store.getRun(runId);
    if (!current || current.status === "blocked") return;
    this.store.transitionRun(
      runId,
      "blocked",
      {
        blocked: {
          reason,
          checkpointRef,
          resumeCommand: `agent-loop resume --run-id ${runId}`,
          recovery: recovery ?? defaultRecoveryDisposition(checkpointRef),
        },
      },
      { reason, checkpointRef },
    );
  }

  private worktreePath(runId: string): string {
    return resolve(this.loopHome, "worktrees", runId);
  }
}

// Checkpoint-derived defaults keep every existing block site typed without
// forcing each caller to restate the obvious; call sites with sharper
// knowledge (provider failure classes) pass an explicit disposition.
// Supervisor failures carry structured classes; a purely transient outage
// (rate limit / transient across every attempted provider) is safely
// retryable after cooldown, while auth/quota and everything else needs a
// human. Unknown or absent outcomes stay conservative.
export function providerRecoveryDisposition(
  outcome: { failures: ReadonlyArray<{ failureClass: string | null; retryAfterMs?: number | null }> } | null,
): RecoveryDisposition {
  const classes = (outcome?.failures ?? []).map((failure) => failure.failureClass);
  if (classes.length > 0 && classes.every((value) => value === "rate_limit" || value === "transient" || value === "timeout")) {
    const retryAfterMs = Math.max(0, ...(outcome?.failures ?? []).map((failure) => failure.retryAfterMs ?? 0));
    return {
      kind: "retryable",
      safeToRepeat: true,
      retryAfter: retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs).toISOString() : null,
    };
  }
  return { kind: "human-action-required", actionType: "authenticate-or-configure-provider" };
}

export function defaultRecoveryDisposition(checkpointRef: string): RecoveryDisposition {
  if (checkpointRef === "worktree" || checkpointRef === "post-merge") {
    return { kind: "retryable", safeToRepeat: true, retryAfter: null };
  }
  if (checkpointRef === "budget-exceeded") {
    return { kind: "human-action-required", actionType: "reduce-scope-or-raise-budget" };
  }
  if (checkpointRef === "risk-classification") {
    return { kind: "human-action-required", actionType: "classify-risk" };
  }
  if (checkpointRef === "provider-recovery") {
    return { kind: "human-action-required", actionType: "authenticate-or-configure-provider" };
  }
  if (checkpointRef === "loop-budget") {
    return { kind: "human-action-required", actionType: "inspect-run" };
  }
  if (checkpointRef === "run-binding") {
    return { kind: "terminal", failureClass: "binding-mismatch" };
  }
  return { kind: "human-action-required", actionType: `inspect-${checkpointRef}` };
}

export { evidenceDependencyHash };

function assertCommit(repository: string, sha: string): void {
  if (!/^[0-9a-f]{7,64}$/iu.test(sha)) throw new Error("Merge SHA must be a hexadecimal commit id");
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: repository,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`Merge SHA is not a commit in the supplied repository: ${sha}`);
  }
}

function commandEnvironmentAllowlist(): string[] {
  return ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSuccessfulCommandResult(
  value: unknown,
  commitSha: string,
  argv: readonly string[],
): boolean {
  return isRecord(value) &&
    value.exitCode === 0 &&
    value.commitBefore === commitSha &&
    value.timedOut === false &&
    value.signal === null &&
    Array.isArray(value.argv) &&
    JSON.stringify(value.argv) === JSON.stringify(argv);
}

function normalizedExistingPath(path: string): string {
  const normalized = realpathSync(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function candidateOperationInput(value: unknown): {
  baseCommit: string;
  workingDiffHash: string;
  message: string;
} {
  if (
    !isRecord(value) ||
    typeof value.baseCommit !== "string" ||
    typeof value.workingDiffHash !== "string" ||
    typeof value.message !== "string"
  ) {
    throw new Error("Candidate commit operation has invalid persisted input");
  }
  return {
    baseCommit: value.baseCommit,
    workingDiffHash: value.workingDiffHash,
    message: value.message,
  };
}

function candidateCommitResult(value: unknown): CandidateCommit {
  if (
    !isRecord(value) ||
    typeof value.baseCommit !== "string" ||
    typeof value.commitSha !== "string" ||
    typeof value.diffHash !== "string" ||
    typeof value.message !== "string" ||
    typeof value.authorName !== "string" ||
    typeof value.authorEmail !== "string"
  ) {
    throw new Error("Candidate commit operation has invalid persisted result");
  }
  return value as unknown as CandidateCommit;
}

function writerOperationInput(value: unknown): { baseCommit: string; attempt: number; gitControlHash: string } {
  if (
    !isRecord(value) ||
    typeof value.baseCommit !== "string" ||
    typeof value.gitControlHash !== "string" ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt <= 0
  ) {
    throw new Error("Writer operation has invalid persisted input");
  }
  return { baseCommit: value.baseCommit, attempt: value.attempt, gitControlHash: value.gitControlHash };
}

function explorerOperationInput(value: unknown): { currentCommit: string; gitControlHash: string } {
  if (
    !isRecord(value) ||
    typeof value.currentCommit !== "string" ||
    typeof value.gitControlHash !== "string"
  ) throw new Error("Explorer operation has invalid persisted input");
  return { currentCommit: value.currentCommit, gitControlHash: value.gitControlHash };
}

function repairPrompt(
  task: ReturnType<typeof loadTaskSpec>,
  attempt: number,
  currentCommit: string,
  failureEvidence: readonly Evidence[],
  budget: RunBudget,
): string {
  // Evidence payloads are machine-observed but content-untrusted (the failing
  // program controls them); each is excerpt-bounded with a hash reference to
  // the full stored evidence instead of inlined without limit.
  const boundedEvidence = failureEvidence.map((item) =>
    `{"id":${JSON.stringify(item.id)},"kind":${JSON.stringify(item.kind)},"data":${boundedJson(item.data, budget.maximumEvidenceExcerptBytes)}}`);
  return [
    `Role: bounded Repair attempt ${attempt}.`,
    `Task: ${task.id}`,
    `Goal: ${task.goal}`,
    `Acceptance: ${JSON.stringify(task.acceptance)}`,
    `Current candidate commit: ${currentCommit}`,
    `Deterministic proof-gap evidence: [${boundedEvidence.join(",")}]`,
    "Fix only the demonstrated failure within the task scope.",
    "Edit files only; do not run git add, git commit, or change Git metadata.",
    "Leave a non-empty working diff for the Harness to inspect and commit deterministically.",
    "Return only a concise summary and the changedFiles array required by the Author output schema.",
  ].join("\n");
}

function failureEvidenceSignature(evidence: Evidence | undefined): string | null {
  return evidence && isRecord(evidence.data) && typeof evidence.data.signature === "string"
    ? evidence.data.signature
    : null;
}

function isCommandFailureResult(value: unknown): boolean {
  return isRecord(value) &&
    Array.isArray(value.argv) &&
    (value.exitCode !== 0 || value.timedOut === true || value.signal !== null);
}

function commandArtifactText(value: unknown, field: "stdoutPath" | "stderrPath"): string {
  if (!isRecord(value) || typeof value[field] !== "string" || !existsSync(value[field])) return "";
  try {
    return readFileSync(value[field], "utf8");
  } catch {
    return "";
  }
}

class SupervisedRoleAdapter implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "unverified" } as const;
  outcome: ProviderSupervisorResult | null = null;

  constructor(
    private readonly supervisor: ProviderSupervisor,
    private readonly validate: (result: ProviderRunResult) => boolean,
    private readonly role: string,
  ) {}

  async probe() {
    return { available: true, identity: supervisorIdentity(), error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.outcome = await this.supervisor.run(request, this.validate);
    return this.outcome.result ?? unavailableProviderResult(
      request,
      `No configured ${this.role} produced a valid result`,
    );
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

function reviewOperationData(value: unknown): {
  reviewedCommit: string;
  diffHash: string;
  controlStateHash: string;
} {
  if (
    !isRecord(value) ||
    typeof value.reviewedCommit !== "string" ||
    typeof value.diffHash !== "string" ||
    typeof value.controlStateHash !== "string"
  ) throw new Error("Review operation has invalid persisted input");
  return {
    reviewedCommit: value.reviewedCommit,
    diffHash: value.diffHash,
    controlStateHash: value.controlStateHash,
  };
}

function unavailableProviderResult(request: ProviderRunRequest, message: string): ProviderRunResult {
  return {
    invocationId: request.invocationId,
    ok: false,
    cancelled: false,
    identity: supervisorIdentity(),
    threadId: null,
    events: [],
    finalOutput: null,
    stderr: message,
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

function providerUsageTokens(result: ProviderRunResult): number {
  return (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
}

function supervisorIdentity() {
  return {
    provider: "provider-supervisor",
    model: null,
    executable: "agent-loop-harness",
    version: null,
  };
}

function configuredProviderFact(provider: ConfiguredProvider): { family: string; name: string } {
  return { family: provider.family, name: provider.name };
}

function providerRank(provider: ConfiguredProvider, order: readonly string[]): number {
  const searchable = `${provider.family}\0${provider.name}`.toLowerCase();
  const index = order.findIndex((value) => searchable.includes(value.toLowerCase()));
  return index < 0 ? order.length : index;
}

function missingProvider(): never {
  throw new Error("Orchestrator requires either provider or providerProfile");
}
