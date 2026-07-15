import type { GitService } from "./execution.js";
import type { ConfiguredProvider } from "./profiles.js";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./provider.js";
import {
  ProviderSupervisor,
  type ProviderSupervisorPersistence,
  type ProviderSupervisorResult,
} from "./provider-supervisor.js";
import { authorOutputSchema } from "./role-output-schemas.js";

export interface WriterExecutionRequest {
  request: ProviderRunRequest;
  legacyProvider: ProviderAdapter;
  candidates: readonly ConfiguredProvider[];
  persistence: ProviderSupervisorPersistence | null;
  authRecoveryCommand: string;
  unknownRecoveryCommand: string;
}

export interface WriterExecutionResult {
  disposition: "succeeded" | "failed" | "blocked";
  result: ProviderRunResult | null;
  selectedAuthor: ConfiguredProvider | null;
  supervisor: ProviderSupervisorResult | null;
}

export class WriterExecutor {
  async execute(input: WriterExecutionRequest): Promise<WriterExecutionResult> {
    if (!input.persistence) {
      const result = await input.legacyProvider.run(input.request);
      return {
        disposition: result.ok ? "succeeded" : "failed",
        result,
        selectedAuthor: null,
        supervisor: null,
      };
    }
    const supervisor = new ProviderSupervisor({
      adapters: input.candidates.map((candidate) => candidate.adapter),
      persistence: input.persistence,
      authRecoveryCommand: input.authRecoveryCommand,
      unknownRecoveryCommand: input.unknownRecoveryCommand,
    });
    const outcome = await supervisor.run(
      input.request,
      (result) => authorOutputSchema.safeParse(result.finalOutput).success,
    );
    const selectedAuthor = outcome.selectedAdapterIndex === null
      ? null
      : input.candidates[outcome.selectedAdapterIndex] ?? null;
    return {
      disposition: outcome.disposition === "succeeded" && outcome.result && selectedAuthor
        ? "succeeded"
        : "blocked",
      result: outcome.result,
      selectedAuthor,
      supervisor: outcome,
    };
  }
}

export function writerBoundaryViolation(
  git: GitService,
  baseCommit: string,
  validOutput: boolean,
  expectedControlHash: string,
): string | null {
  if (git.head() !== baseCommit) return "Writer changed Git HEAD; only the Harness may commit";
  if (git.hasStagedChanges()) return "Writer changed the Git index; only the Harness may stage files";
  if (git.controlStateHash() !== expectedControlHash) {
    return "Writer changed Git refs or reflogs; only the Harness may change Git control state";
  }
  if (!git.isDirty()) return "Writer produced no working diff";
  if (!validOutput) return "Writer returned invalid structured output";
  return null;
}
