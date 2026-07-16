import { resolve } from "node:path";
import { operationInputHash } from "../bindings.js";
import type { RunBinding } from "../domain.js";
import { CommandRunner, GitService, type WorktreeService } from "../execution.js";
import type { ConfigurationVariant } from "../evolution/proposals.js";
import type { SanitizedFactBundle } from "./facts.js";
import {
  HistoricalReplay,
  pinnedVerificationCommit,
  type EvaluationOutcome,
  type EvaluationRun,
  type EvaluationRunRepository,
} from "./replay.js";

const safeEnvironment = [
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
    const receipts = [];
    for (const command of input.binding.taskSpec.verification) {
      const result = await this.runner.run({
        argv: command.argv,
        cwd: input.binding.worktreePath,
        artifactDirectory: resolve(input.artifactDirectory, command.id),
        environmentAllowlist: safeEnvironment,
        timeoutMs: 60_000,
        outputLimitBytes: 1024 * 1024,
        shell: false,
      });
      receipts.push({
        commandId: command.id,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        commitBefore: result.commitBefore,
      });
    }
    return {
      passed: receipts.every((receipt) => receipt.exitCode === 0 && receipt.signal === null &&
        !receipt.timedOut && receipt.commitBefore === commit),
      evidenceHash: operationInputHash(receipts),
      diagnostics: receipts.filter((receipt) => receipt.exitCode !== 0).map((receipt) => receipt.commandId),
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
      return replay.run({
        id: input.id,
        facts: input.facts,
        binding: evaluationBinding,
        mode: "full",
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
