import { resolve } from "node:path";
import { operationInputHash } from "../bindings.js";
import type { RunBinding } from "../domain.js";
import {
  CommandRunner,
  GitService,
  commandReceiptProofProjection,
  commandReceiptProvesSuccess,
  type CommandRequest,
  type CommandResult,
  type WorktreeService,
} from "../execution.js";
import type { ConfigurationVariant } from "../evolution/proposals.js";
import type { SanitizedFactBundle } from "./facts.js";
import {
  HistoricalReplay,
  pinnedVerificationCommit,
  type EvaluationOutcome,
  type EvaluationRun,
  type EvaluationRunRepository,
} from "./replay.js";

export const safeEnvironment = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
] as const;

export class VerifyOnlyEvaluator {
  readonly kind = "verify-only" as const;
  readonly version = "verify-only/v1";

  constructor(private readonly runner = new CommandRunner()) {}

  async evaluate(input: {
    facts: SanitizedFactBundle;
    binding: RunBinding;
    artifactDirectory: string;
  }): Promise<EvaluationOutcome> {
    const commit = pinnedVerificationCommit(input.facts);
    if (!commit || new GitService(input.binding.worktreePath).head() !== commit) {
      throw new Error("PinnedVerificationCommitUnavailable");
    }
    const receipts: Array<{ commandId: string; result: CommandResult; passed: boolean }> = [];
    for (const command of input.binding.taskSpec.verification) {
      const request: CommandRequest = {
        argv: command.argv,
        cwd: input.binding.worktreePath,
        artifactDirectory: resolve(input.artifactDirectory, command.id),
        environmentAllowlist: safeEnvironment,
        timeoutMs: 60_000,
        outputLimitBytes: 1024 * 1024,
        shell: false,
        policyVersion: input.binding.policyVersion,
        configurationHash: input.binding.configurationHash,
      };
      const expectation = this.runner.receiptExpectation(request);
      const result = await this.runner.run(request);
      receipts.push({
        commandId: command.id,
        result,
        passed: expectation.sourceCommit === commit && commandReceiptProvesSuccess(result, expectation),
      });
    }
    return {
      passed: receipts.every((receipt) => receipt.passed),
      evidenceHash: operationInputHash(receipts.map((receipt) => ({
        commandId: receipt.commandId,
        passed: receipt.passed,
        proof: commandReceiptProofProjection(receipt.result),
      }))),
      diagnostics: receipts.filter((receipt) => !receipt.passed).map((receipt) => receipt.commandId),
    };
  }
}

export interface FullTaskExecutionInput {
  facts: SanitizedFactBundle;
  binding: RunBinding;
  worktreePath: string;
  artifactDirectory: string;
  configurationVariant: ConfigurationVariant;
}

export type FullTaskExecutor = (input: FullTaskExecutionInput) => Promise<EvaluationOutcome>;

export class FullTaskReplayEvaluator {
  readonly kind = "full-task-replay" as const;

  constructor(
    private readonly repository: EvaluationRunRepository,
    private readonly worktrees: Pick<WorktreeService, "create" | "remove">,
    private readonly executor: FullTaskExecutor,
    private readonly evaluationRoot: string,
    readonly version = "full-task-replay/v1",
  ) {}

  async evaluate(input: {
    id: string;
    facts: SanitizedFactBundle;
    binding: RunBinding;
    configurationVariant: ConfigurationVariant;
    createdAt?: string;
  }): Promise<EvaluationRun> {
    if (input.configurationVariant.projectScope !== input.binding.projectAdapterName) {
      throw new Error("Full Task Replay configuration does not match the project scope");
    }
    const safeId = input.id.replace(/[^a-zA-Z0-9._-]+/gu, "-");
    const worktreePath = resolve(this.evaluationRoot, "worktrees", safeId);
    const branch = `agent-loop/evaluation-${safeId}`;
    const created = this.worktrees.create(worktreePath, branch, input.binding.baselineCommit);
    try {
      if (created.head !== input.binding.baselineCommit) {
        throw new Error("Evaluation Worktree is not pinned to the Baseline Commit");
      }
      const evaluationBinding: RunBinding = { ...input.binding, worktreePath: created.path };
      const replay = new HistoricalReplay(this.repository, async (facts, mode, binding) => {
        if (mode !== "full") throw new Error("FullTaskReplayEvaluator only accepts full mode");
        return this.executor({
          facts,
          binding,
          worktreePath: created.path,
          artifactDirectory: resolve(this.evaluationRoot, "artifacts", safeId),
          configurationVariant: input.configurationVariant,
        });
      });
      // Must await inside the try: a bare `return promise` runs the finally
      // (removing the worktree) before the replay has finished using it.
      return await replay.run({
        id: input.id,
        facts: input.facts,
        binding: evaluationBinding,
        mode: "full",
        // Required manifests are derived from the fact bundle itself so a run
        // whose repair or reviewer operations lack manifests cannot grade
        // manifest-complete just because the caller forgot to list them.
        requiredOperationIds: input.facts.operations
          .filter((operation) => ["explorer", "author", "repair", "reviewer"].includes(operation.kind))
          .map((operation) => operation.id),
        championVersion: input.configurationVariant.status === "champion" ? input.configurationVariant.version : "baseline",
        challengerVersion: input.configurationVariant.status === "challenger" ? input.configurationVariant.version : null,
        evaluatorKind: this.kind,
        evaluatorVersion: this.version,
        configurationVariantId: input.configurationVariant.id,
        configurationHash: input.configurationVariant.configurationHash,
        createdAt: input.createdAt,
      });
    } finally {
      this.worktrees.remove(worktreePath, true);
    }
  }
}
