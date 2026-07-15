import { resolve } from "node:path";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./provider.js";
import { ProviderSupervisor, type ProviderSupervisorResult } from "./provider-supervisor.js";
import { reviewReportSchema, reviewerOutputSchema } from "./reviewer.js";

export class ReviewExecutor implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "unverified" } as const;
  outcome: ProviderSupervisorResult | null = null;

  constructor(private readonly supervisor: ProviderSupervisor) {}

  async probe() {
    return { available: true, identity: supervisorIdentity(), error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.outcome = await this.supervisor.run(
      request,
      (result) => reviewerOutputSchema.safeParse(result.finalOutput).success,
    );
    return this.outcome.result ?? unavailableReviewResult(request);
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

export class ReviewProviderCompletionInterruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewProviderCompletionInterruption";
  }
}

export function reviewReportFromProvider(result: ProviderRunResult, reviewedCommit: string) {
  const parsed = reviewerOutputSchema.safeParse(result.finalOutput);
  if (!result.ok || !parsed.success) return null;
  return reviewReportSchema.parse({
    findings: parsed.data.findings.map((finding) => ({
      ...finding,
      reviewerIdentity: {
        provider: result.identity.provider,
        model: result.identity.model,
        executable: result.identity.executable,
        version: result.identity.version,
      },
      reviewedCommit,
    })),
  });
}

export function providerRunResultFromUnknown(value: unknown): ProviderRunResult | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.invocationId !== "string" ||
    !isRecord(value.identity) ||
    typeof value.identity.provider !== "string" ||
    typeof value.identity.executable !== "string" ||
    !Array.isArray(value.events) ||
    typeof value.stderr !== "string" ||
    typeof value.durationMs !== "number" ||
    typeof value.eventsPath !== "string" ||
    typeof value.finalOutputPath !== "string" ||
    typeof value.stderrPath !== "string"
  ) return null;
  return value as unknown as ProviderRunResult;
}

function unavailableReviewResult(request: ProviderRunRequest): ProviderRunResult {
  return {
    invocationId: request.invocationId,
    ok: false,
    cancelled: false,
    identity: supervisorIdentity(),
    threadId: null,
    events: [],
    finalOutput: null,
    stderr: "No configured independent Reviewer produced a valid result",
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

function supervisorIdentity() {
  return {
    provider: "provider-supervisor",
    model: null,
    executable: "agent-loop-harness",
    version: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
