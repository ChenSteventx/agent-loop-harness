import { resolve } from "node:path";
import { operationInputHash } from "./bindings.js";
import { CommandRunner, GitService } from "./execution.js";
import type { VerificationCommand } from "./ports.js";
import type { ProviderAdapter } from "./provider.js";
import { authorOutputSchema, defaultRoleOutputSchemas } from "./role-output-schemas.js";
import type { TaskSpec } from "./task-spec.js";
import { assertPromptWithinBudget, boundAdvisoryText } from "./budget.js";
import { authorPrompt } from "./roles.js";
import { WriterExecutor, writerBoundaryViolation } from "./writer-executor.js";
import { safeEnvironment, type FullTaskExecutor } from "./evaluation/evaluators.js";

export interface FullTaskExecutorOptions {
  adapters: Readonly<Record<string, ProviderAdapter>>;
  defaultFamily: string;
  verificationCommands: (task: TaskSpec) => readonly VerificationCommand[];
  commandRunner?: CommandRunner;
  // memory-retrieval target: evaluated per variant configuration so an
  // offline comparison can measure retrieval on versus off for the same
  // historical task.
  memoryRetriever?: (input: { projectScope: string; task: TaskSpec }) => string | null;
}

export function createFullTaskExecutor(options: FullTaskExecutorOptions): FullTaskExecutor {
  if (!(options.defaultFamily in options.adapters)) {
    throw new Error(`Full Task Replay default provider family is not configured: ${options.defaultFamily}`);
  }
  const runner = options.commandRunner ?? new CommandRunner();
  return async (input) => {
    const configuration = input.configurationVariant.configuration;
    const adapter = selectAuthor(options, configuration.providerOrder);
    const git = new GitService(input.worktreePath, input.binding.budget);
    const baseCommit = git.head();
    const controlHash = git.controlStateHash();
    const diagnostics: string[] = [];
    const memoryAdvisory = configuration.memoryRetrievalEnabled
      ? boundAdvisoryText(
        options.memoryRetriever?.({
          projectScope: input.binding.projectAdapterName,
          task: input.binding.taskSpec,
        }) ?? null,
        input.binding.budget.maximumExplorerAdvisoryBytes,
      )
      : null;
    const evaluationPrompt = authorPrompt(input.binding.taskSpec, null, {
      variant: configuration.promptVariant,
      memoryAdvisory,
    });
    assertPromptWithinBudget(evaluationPrompt, input.binding.budget.maximumPromptBytes, "evaluation-author");
    const attempts = Math.min(Math.max(configuration.retryLimit, 0), 3) + 1;
    let providerOk = false;
    let finalOutput: unknown = null;
    for (let attempt = 1; attempt <= attempts && !providerOk; attempt += 1) {
      const execution = await new WriterExecutor().execute({
        request: {
          invocationId: `${input.facts.run.id}:evaluation-author:${attempt}`,
          prompt: evaluationPrompt,
          maximumPromptBytes: input.binding.budget.maximumPromptBytes,
          cwd: input.worktreePath,
          artifactDirectory: resolve(input.artifactDirectory, `author-attempt-${attempt}`),
          outputSchemaPath: defaultRoleOutputSchemas().author,
          workspaceAccess: "workspace-write",
          allowedRepositoryRoots: [input.worktreePath],
          model: configuration.roleModels["author"] ?? null,
        },
        legacyProvider: adapter,
        candidates: [],
        persistence: null,
        authRecoveryCommand: "re-run the offline comparison after re-authenticating the provider",
        unknownRecoveryCommand: "inspect the evaluation artifacts, then re-run the offline comparison",
      });
      if (execution.disposition === "succeeded" && execution.result?.ok) {
        providerOk = true;
        finalOutput = execution.result.finalOutput;
      } else {
        diagnostics.push(`author-attempt-${attempt}:${execution.result?.failureClass ?? "failed"}`);
        if (git.isDirty()) {
          // A failed attempt that already wrote files would contaminate the
          // next attempt's worktree and the eventual candidate commit; abort
          // instead of retrying on a tainted tree.
          diagnostics.push("dirty-worktree-after-failed-attempt");
          break;
        }
      }
    }
    if (!providerOk) return { passed: false, evidenceHash: null, diagnostics };
    const parsedOutput = authorOutputSchema.safeParse(finalOutput);
    const violation = writerBoundaryViolation(git, baseCommit, parsedOutput.success, controlHash);
    if (violation !== null) {
      return { passed: false, evidenceHash: null, diagnostics: [...diagnostics, violation] };
    }
    const candidate = git.commitCandidate({
      baseCommit,
      message: `agent-loop(${input.binding.taskSpec.id}): evaluation replay candidate`,
    });
    const receipts = [];
    for (const command of options.verificationCommands(input.binding.taskSpec)) {
      const result = await runner.run({
        argv: command.argv,
        cwd: input.worktreePath,
        artifactDirectory: resolve(input.artifactDirectory, "verify", command.id),
        environmentAllowlist: safeEnvironment,
        timeoutMs: configuration.timeoutMs,
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
    const passed = receipts.every((receipt) => receipt.exitCode === 0 && receipt.signal === null &&
      !receipt.timedOut && receipt.commitBefore === candidate.commitSha);
    return {
      passed,
      evidenceHash: operationInputHash({
        candidateCommit: candidate.commitSha,
        diffHash: candidate.diffHash,
        receipts,
      }),
      diagnostics: [
        ...diagnostics,
        ...receipts.filter((receipt) => receipt.exitCode !== 0).map((receipt) => receipt.commandId),
      ],
    };
  };
}

function selectAuthor(options: FullTaskExecutorOptions, providerOrder: readonly string[]): ProviderAdapter {
  for (const family of providerOrder) {
    const match = Object.keys(options.adapters).find((key) =>
      key.toLowerCase() === family.toLowerCase() || family.toLowerCase().includes(key.toLowerCase()));
    if (match) return options.adapters[match]!;
  }
  return options.adapters[options.defaultFamily]!;
}
