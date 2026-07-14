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
import type { ProjectAdapter, VerificationCommand } from "./ports.js";
import type { ProviderAdapter } from "./provider.js";
import { loadTaskSpec } from "./project.js";
import { SqliteStore } from "./store.js";
import type { Run } from "./domain.js";
import { canBecomeReady } from "./routing.js";
import { routeRisk } from "./routing.js";
import { compactExplorerReport, runExplorer, type ExplorerReport } from "./explorer.js";
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

export function defaultLoopHome(): string {
  return resolve(homedir(), ".agent-loop-harness");
}

export interface OrchestratorOptions {
  loopHome?: string;
  provider: ProviderAdapter;
  projectAdapter: ProjectAdapter;
  roleOutputSchemas?: Partial<RoleOutputSchemas>;
  /** @deprecated Supply roleOutputSchemas instead. */
  outputSchemaPath?: string;
  providerProfileName?: string;
  commandRunner?: CommandRunner;
  explorerContextBudget?: number;
  faults?: {
    afterProviderCompletion?: () => void;
    afterHarnessCommit?: () => void;
  };
}

export interface StartRunRequest {
  runId?: string;
  taskPath: string;
  targetRepository: string;
}

export interface RunView {
  run: Run;
  operations: ReturnType<SqliteStore["listOperations"]>;
  evidence: ReturnType<SqliteStore["listEvidence"]>;
  events: ReturnType<SqliteStore["listEvents"]>;
  worktreePath: string;
  worktreeExists: boolean;
}

export class Orchestrator {
  readonly loopHome: string;
  readonly store: SqliteStore;
  private readonly provider: ProviderAdapter;
  private readonly projectAdapter: ProjectAdapter;
  private readonly roleOutputSchemas: RoleOutputSchemas;
  private readonly commandRunner: CommandRunner;
  private readonly afterProviderCompletion?: () => void;
  private readonly afterHarnessCommit?: () => void;
  private readonly explorerContextBudget: number;
  private readonly providerProfileName: string;

  constructor(options: OrchestratorOptions) {
    this.loopHome = resolve(options.loopHome ?? process.env.LOOP_HOME ?? defaultLoopHome());
    mkdirSync(this.loopHome, { recursive: true });
    this.store = new SqliteStore(resolve(this.loopHome, "state.sqlite"));
    this.provider = options.provider;
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
    this.explorerContextBudget = options.explorerContextBudget ?? 8_000;
    this.providerProfileName = options.providerProfileName ?? "LEGACY_SINGLE_PROVIDER";
  }

  close(): void {
    this.store.close();
  }

  async start(request: StartRunRequest): Promise<RunView> {
    const taskPath = resolve(request.taskPath);
    const task = loadTaskSpec(taskPath);
    const runId = request.runId ?? randomUUID();
    if (this.store.getRun(runId)) throw new Error(`Run already exists: ${runId}`);
    const sourceGit = new GitService(request.targetRepository);
    const worktreePath = this.worktreePath(runId);
    const binding = createRunBinding({
      taskSpecPath: taskPath,
      taskSpec: task,
      baselineCommit: sourceGit.head(),
      sourceRepository: sourceGit.root,
      worktreePath,
      providerProfile: this.providerProfileName,
      projectAdapter: this.projectAdapter,
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

    let explorerReport: ExplorerReport | null = null;
    if (routeRisk(task.risk) === "assisted") {
      const explorer = this.store.createOperation({
        id: `${runId}:explorer`, runId, kind: "explorer", idempotencyKey: `${runId}:explorer`,
      });
      const explorerGit = new GitService(worktreePath);
      const explorerHead = explorerGit.head();
      const result = await runExplorer(this.provider, {
        task,
        baselineCommit: worktree.head,
        currentCommit: new GitService(worktreePath).head(),
        allowedRepositoryRoots: [worktreePath],
        contextBudget: this.explorerContextBudget,
      }, {
        invocationId: explorer.id,
        cwd: worktreePath,
        artifactDirectory: resolve(this.loopHome, "runs", runId, "explorer"),
        outputSchemaPath: this.roleOutputSchemas.explorer,
      });
      this.store.recordAgentCall(runId, {
        role: "explorer", provider: result.provider.identity.provider,
        latencyMs: result.latencyMs, usage: result.provider.usage,
      });
      if (explorerGit.head() !== explorerHead || explorerGit.isDirty()) {
        this.store.finishOperation(explorer.id, "failed", {
          report: null,
          costTokens: result.costTokens,
          latencyMs: result.latencyMs,
          used: false,
          reason: "Explorer violated the read-only workspace boundary",
        });
        throw new Error("Explorer violated the read-only workspace boundary");
      }
      explorerReport = result.report;
      this.store.finishOperation(explorer.id, explorerReport ? "succeeded" : "failed", {
        report: explorerReport,
        costTokens: result.costTokens,
        latencyMs: result.latencyMs,
        used: result.used,
        failureClass: result.provider.failureClass,
      });
    }

    const authorInput = {
      role: "author",
      attempt: 1,
      baseCommit: worktree.head,
      taskSpecHash: binding.taskSpecHash,
      acceptanceHash: binding.acceptanceHash,
    };
    const author = this.store.createOperation({
      id: `${runId}:author`,
      runId,
      kind: "author",
      idempotencyKey: `${runId}:author`,
      input: authorInput,
    });
    const providerResult = await this.provider.run({
      invocationId: author.id,
      prompt: authorPrompt(task, explorerReport),
      cwd: worktreePath,
      artifactDirectory: resolve(this.loopHome, "runs", runId, "author"),
      outputSchemaPath: this.roleOutputSchemas.author,
      workspaceAccess: "workspace-write",
      allowedRepositoryRoots: [worktreePath],
    });
    this.store.recordAgentCall(runId, {
      role: "author", provider: providerResult.identity.provider,
      latencyMs: providerResult.durationMs, usage: providerResult.usage,
    });
    this.afterProviderCompletion?.();
    if (!providerResult.ok) {
      this.store.finishOperation(author.id, "failed", providerResult);
      this.block(runId, `Author failed: ${providerResult.failureClass ?? "unknown"}`, author.id);
      return this.status(runId);
    }
    const authorOutput = authorOutputSchema.safeParse(providerResult.finalOutput);
    if (!authorOutput.success) {
      this.store.finishOperation(author.id, "failed", {
        provider: providerResult,
        reason: "Author returned output that does not match the Author schema",
      });
      this.block(runId, "Author returned invalid structured output", author.id);
      return this.status(runId);
    }

    const authoredGit = new GitService(worktreePath);
    if (authoredGit.head() !== worktree.head || !authoredGit.isDirty() || authoredGit.hasStagedChanges()) {
      const reason = authoredGit.head() !== worktree.head
        ? "Author changed Git HEAD; only the Harness may commit"
        : authoredGit.hasStagedChanges()
          ? "Author changed the Git index; only the Harness may stage files"
          : "Author produced no working diff";
      this.store.finishOperation(author.id, "failed", {
        provider: providerResult,
        reason,
      });
      this.block(runId, reason, author.id);
      return this.status(runId);
    }
    this.store.finishOperation(author.id, "succeeded", {
      provider: providerResult,
      report: authorOutput.data,
      worktreePath,
      baseCommit: worktree.head,
      workingDiffHash: authoredGit.diffHash(),
    });
    const candidate = this.ensureCandidateCommit(runId, authoredGit, author.id, 1);
    if (!candidate) return this.status(runId);

    const commands = this.projectAdapter.verificationCommands(task);
    if (commands.length === 0) {
      this.block(runId, "No verification commands were configured", author.id);
      return this.status(runId);
    }
    const verified = await this.verifyCommands(runId, worktreePath, commands, "verify");
    if (!verified) return this.status(runId);

    if (!canBecomeReady(task.risk)) {
      this.block(runId, "Risk must be classified before the run can become ready", "risk-classification");
      return this.status(runId);
    }

    this.store.transitionRun(runId, "ready", {}, { commitSha: candidate.commitSha });
    return this.status(runId);
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
    return this.verifyOpenRun(runId, task);
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
    const worktreePath = run.binding?.worktreePath ?? this.worktreePath(runId);
    if (!existsSync(worktreePath)) {
      this.block(runId, "Task worktree is missing", "worktree");
      return this.status(runId);
    }
    const git = new GitService(worktreePath);
    const author = this.store.listOperations(runId).find((operation) => operation.kind === "author");
    if (!author) {
      this.block(runId, "Author operation is missing", "author");
      return this.status(runId);
    }
    if (author.status === "failed") {
      this.block(runId, "Author operation previously failed; start a new bounded run", author.id);
      return this.status(runId);
    }
    if (author.status === "running") {
      const bound = this.requireBoundRun(runId).binding;
      if (git.head() !== bound.baselineCommit || !git.isDirty() || git.hasStagedChanges()) {
        this.store.finishOperation(author.id, "failed", {
          reason: "Author recovery cannot prove a bounded working diff without Git metadata changes",
        });
        this.block(runId, "Author recovery found an invalid Git state", author.id);
        return this.status(runId);
      }
      const finalOutputPath = resolve(this.loopHome, "runs", runId, "author", "final.json");
      let recoveredOutput: ReturnType<typeof authorOutputSchema.safeParse> | null = null;
      try {
        recoveredOutput = existsSync(finalOutputPath)
          ? authorOutputSchema.safeParse(JSON.parse(readFileSync(finalOutputPath, "utf8")) as unknown)
          : null;
      } catch {
        recoveredOutput = null;
      }
      if (!recoveredOutput?.success) {
        this.store.finishOperation(author.id, "failed", {
          reason: "Author recovery is missing valid structured output",
        });
        this.block(runId, "Author recovery is missing its structured receipt", author.id);
        return this.status(runId);
      }
      this.store.finishOperation(author.id, "succeeded", {
        recoveredAfterProviderCompletion: true,
        worktreePath,
        baseCommit: bound.baselineCommit,
        workingDiffHash: git.diffHash(),
        report: recoveredOutput.data,
      });
      this.store.appendEvent(runId, "author.recovered", { operationId: author.id, workingDiffHash: git.diffHash() });
    }
    const candidate = this.ensureCandidateCommit(runId, git, author.id, 1);
    if (!candidate) return this.status(runId);

    const commands = this.projectAdapter.verificationCommands(task);
    const expectedHashes = commands.map((command) =>
      this.commandEvidenceReceipt(runId, candidate.commitSha, worktreePath, "verify", command).dependencyHash,
    );
    this.store.invalidateEvidenceOfKindsExcept(runId, ["command"], expectedHashes);
    const validHashes = new Set(this.store.listEvidence(runId, "valid").map((item) => item.dependencyHash));

    if (run.status === "ready") {
      if (expectedHashes.length > 0 && expectedHashes.every((hash) => validHashes.has(hash))) {
        return this.status(runId);
      }
      this.store.reopenRunForInvalidEvidence(runId);
    }
    return this.verifyOpenRun(runId, task);
  }

  private async verifyOpenRun(runId: string, task: ReturnType<typeof loadTaskSpec>): Promise<RunView> {
    const run = this.requireBoundRun(runId);
    const worktreePath = run.binding.worktreePath;
    const git = new GitService(worktreePath);
    if (git.isDirty()) {
      this.block(runId, "Task worktree is dirty; verification requires a committed state", "verify");
      return this.status(runId);
    }
    const commands = this.projectAdapter.verificationCommands(task);
    if (commands.length === 0) {
      this.block(runId, "No verification commands were configured", "verify");
      return this.status(runId);
    }
    const expectedHashes = commands.map((command) =>
      this.commandEvidenceReceipt(runId, git.head(), worktreePath, "verify", command).dependencyHash,
    );
    this.store.invalidateEvidenceOfKindsExcept(runId, ["command"], expectedHashes);
    if (await this.verifyCommands(runId, worktreePath, commands, "verify")) {
      if (canBecomeReady(task.risk)) {
        this.store.transitionRun(runId, "ready", {}, { commitSha: git.head() });
      } else {
        this.block(runId, "Risk must be classified before the run can become ready", "risk-classification");
      }
    }
    return this.status(runId);
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
        this.block(runId, `Previous ${stepId} operation failed`, operation.id);
        return false;
      }
      try {
        const result = await this.commandRunner.run({
          argv: command.argv,
          cwd: worktreePath,
          artifactDirectory: resolve(this.loopHome, "runs", runId, phase, command.id),
          environmentAllowlist: commandEnvironmentAllowlist(),
          timeoutMs: 10 * 60_000,
          outputLimitBytes: 1024 * 1024,
        });
        this.store.finishOperation(operation.id, result.exitCode === 0 ? "succeeded" : "failed", result);
        if (result.exitCode !== 0) {
          this.block(runId, `Verification ${command.id} failed with exit ${result.exitCode}`, operation.id);
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
      } catch (error) {
        this.store.finishOperation(operation.id, "failed", { error: errorMessage(error) });
        this.block(runId, `Verification ${command.id} could not run: ${errorMessage(error)}`, operation.id);
        return false;
      }
    }
    return true;
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
        this.afterHarnessCommit?.();
      } else {
        if (git.isDirty() || git.parent() !== input.baseCommit) {
          this.store.finishOperation(operation.id, "failed", {
            reason: "Cannot recover a unique Harness-owned candidate commit",
            currentHead: git.head(),
          });
          this.block(runId, "Candidate commit recovery is ambiguous", operation.id);
          return null;
        }
        candidate = {
          baseCommit: input.baseCommit,
          commitSha: git.head(),
          diffHash: git.diffHashBetween(input.baseCommit),
          message: input.message,
          authorName: "Agent Loop Harness",
          authorEmail: "agent-loop@localhost",
        };
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
    const stepId = `candidate-commit:${attempt}`;
    const dependencies = evidenceDependencies({
      commitSha: candidate.commitSha,
      taskSpecHash: run.binding.taskSpecHash,
      acceptanceHash: run.binding.acceptanceHash,
      policyVersion: run.binding.policyVersion,
      stepId,
      operationInputHash: operationInputHash(operationInput),
    });
    const dependencyHash = evidenceDependencyHash(dependencies);
    this.store.installEvidence({
      id: `${runId}:evidence:candidate:${dependencyHash.slice(0, 12)}`,
      runId,
      operationId: operation.id,
      kind: "candidate_commit",
      commitSha: candidate.commitSha,
      policyVersion: run.binding.policyVersion,
      stepId,
      dependencyHash,
      dependencies,
      data: candidate,
    });
    return candidate;
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

  private block(runId: string, reason: string, checkpointRef: string): void {
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
        },
      },
      { reason, checkpointRef },
    );
  }

  private worktreePath(runId: string): string {
    return resolve(this.loopHome, "worktrees", runId);
  }
}

export { evidenceDependencyHash };

function authorPrompt(task: ReturnType<typeof loadTaskSpec>, explorerReport: ExplorerReport | null): string {
  return [
    `Task: ${task.id}`,
    `Goal: ${task.goal}`,
    "Acceptance:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...(explorerReport ? [`Explorer advisory report: ${compactExplorerReport(explorerReport)}`] : []),
    "Work only in the current worktree. Edit files only; do not run git add, git commit, or change Git metadata.",
    "Leave a non-empty working diff for the Harness to inspect and commit deterministically.",
    "Return only a concise summary and the changedFiles array required by the Author output schema.",
  ].join("\n");
}

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
