import { createHash } from "node:crypto";
import { z } from "zod";
import { assertPromptWithinBudget } from "./budget.js";
import type { FindingVerificationRequest } from "./ports.js";
import type { ProviderAdapter, ProviderIdentity, ProviderRunRequest, ProviderRunResult } from "./provider.js";
import type { TaskSpec } from "./task-spec.js";

export const findingCategories = ["correctness", "acceptance", "security", "reliability", "test", "maintainability"] as const;
export const findingSeverities = ["low", "medium", "high", "critical"] as const;
export const findingStatuses = ["proposed", "confirmed", "rejected", "fixed"] as const;

const findingVerificationRequestSchema: z.ZodType<FindingVerificationRequest> = z.object({
  verificationStepId: z.string().trim().min(1).max(256).optional(),
  proposedArgv: z.tuple([z.string().trim().min(1).max(1024)]).rest(z.string().max(1024)).optional(),
  expectedExitCode: z.number().int().optional(),
  stdoutIncludes: z.string().min(1).max(2000).optional(),
  stderrIncludes: z.string().min(1).max(2000).optional(),
}).strict();

export const reviewerFindingOutputSchema = z.object({
  id: z.string().trim().min(1).max(256),
  category: z.enum(findingCategories),
  severity: z.enum(findingSeverities),
  claim: z.string().trim().min(1).max(4000),
  location: z.string().trim().min(1).max(1024),
  verificationRequest: findingVerificationRequestSchema.nullable(),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(50),
  confidence: z.number().min(0).max(1),
  proposedVerification: z.string().trim().min(1).max(2000),
  status: z.literal("proposed"),
}).strict();

const reviewerIdentitySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().nullable(),
  executable: z.string().trim().min(1),
  version: z.string().nullable(),
}).strict();

export const reviewerOutputSchema = z.object({ findings: z.array(reviewerFindingOutputSchema).max(100) }).strict();

export const findingSchema = reviewerFindingOutputSchema.extend({
  status: z.enum(findingStatuses),
  reviewerIdentity: z.object({
    provider: z.string().trim().min(1),
    model: z.string().nullable(),
    executable: z.string().trim().min(1),
    version: z.string().nullable(),
  }).strict(),
  reviewedCommit: z.string().trim().min(1),
}).strict();

export const reviewReportSchema = z.object({ findings: z.array(findingSchema) }).strict();
export type Finding = z.infer<typeof findingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export interface VerificationEvidence {
  evidenceId: string;
  command: readonly string[];
  exitCode: number;
  commitSha: string;
  result: string;
}

export interface ReviewerInput {
  task: TaskSpec;
  diff: string;
  reviewedCommit: string;
  diffHash: string;
  controlStateHash: string;
  verificationEvidence: readonly VerificationEvidence[];
  allowedRepositoryRoots: readonly string[];
  contextBudget: number;
}

export interface ReviewSnapshot {
  commit: string;
  diffHash: string;
  controlStateHash: string;
  dirty: boolean;
}

export interface ReviewerResult {
  report: ReviewReport | null;
  provider: ProviderRunResult;
  renderedPrompt: string;
  reviewedCommit: string;
  diffHash: string;
  stale: boolean;
}

export interface FindingPolicy {
  blockWithoutEvidence?: boolean;
  blockingSeverities?: readonly Finding["severity"][];
}

export async function runReviewer(
  provider: ProviderAdapter,
  input: ReviewerInput,
  snapshot: () => ReviewSnapshot,
  request: Omit<ProviderRunRequest, "prompt" | "workspaceAccess" | "allowedRepositoryRoots" | "contextBudget" | "additionalWritableDirectories">,
): Promise<ReviewerResult> {
  validateBinding(input, snapshot());
  const renderedPrompt = renderReviewerPrompt(input);
  assertPromptWithinBudget(renderedPrompt, request.maximumPromptBytes, "reviewer");
  const providerResult = await provider.run({
    ...request,
    prompt: renderedPrompt,
    workspaceAccess: "read-only",
    allowedRepositoryRoots: input.allowedRepositoryRoots,
    contextBudget: input.contextBudget,
  });
  const after = snapshot();
  if (
    after.dirty ||
    after.commit !== input.reviewedCommit ||
    after.diffHash !== input.diffHash ||
    after.controlStateHash !== input.controlStateHash
  ) {
    throw new Error("Reviewer violated the read-only workspace boundary or review binding changed");
  }
  const parsed = providerResult.ok ? reviewerOutputSchema.safeParse(providerResult.finalOutput) : null;
  const report = parsed?.success
    ? reviewReportSchema.parse({
        findings: parsed.data.findings.map((finding) => ({
          ...finding,
          reviewerIdentity: harnessIdentity(providerResult.identity),
          reviewedCommit: input.reviewedCommit,
        })),
      })
    : null;
  return { report, provider: providerResult, renderedPrompt, reviewedCommit: input.reviewedCommit, diffHash: input.diffHash, stale: false };
}

export function invalidateStaleReview(result: ReviewerResult, current: Pick<ReviewSnapshot, "commit" | "diffHash">): ReviewerResult {
  return current.commit === result.reviewedCommit && current.diffHash === result.diffHash
    ? result
    : { ...result, report: null, stale: true };
}

export function isBlockingFinding(finding: Finding, policy: FindingPolicy = {}): boolean {
  if (finding.status !== "confirmed") return false;
  return (policy.blockingSeverities ?? ["high", "critical"]).includes(finding.severity);
}

export function conflictResolution(finding: Finding): "evidence_request" | "deterministic_experiment" {
  return finding.verificationRequest === null && finding.evidenceIds.length === 0
    ? "evidence_request"
    : "deterministic_experiment";
}

export async function runReviewedRepair<T>(initial: T, repair: (value: T) => Promise<T>, verify: (value: T) => Promise<boolean>): Promise<{ value: T; repairs: 0 | 1; verified: boolean }> {
  if (await verify(initial)) return { value: initial, repairs: 0, verified: true };
  const repaired = await repair(initial);
  return { value: repaired, repairs: 1, verified: await verify(repaired) };
}

export function hashReviewDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function validateBinding(input: ReviewerInput, current: ReviewSnapshot): void {
  if (hashReviewDiff(input.diff) !== input.diffHash) throw new Error("Reviewer diff hash does not match the supplied diff");
  if (
    current.dirty ||
    current.commit !== input.reviewedCommit ||
    current.diffHash !== input.diffHash ||
    current.controlStateHash !== input.controlStateHash
  ) {
    throw new Error("Reviewer input is stale or workspace is dirty");
  }
  if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget <= 0) throw new Error("Reviewer context budget must be a positive integer");
}

export function renderReviewerPrompt(input: ReviewerInput): string {
  return [
    "Role: independent read-only Reviewer. Do not write files or change run state.",
    `Task spec and acceptance: ${JSON.stringify(input.task)}`,
    `Reviewed commit: ${input.reviewedCommit}`,
    `Diff SHA-256: ${input.diffHash}`,
    `Diff: ${input.diff}`,
    `Verification evidence: ${JSON.stringify(input.verificationEvidence)}`,
    "Every Finding must have status proposed. The Harness alone may confirm, reject, or fix it.",
    "A verificationRequest is advisory. Propose a declared verificationStepId and a concrete observable result.",
    "The Project Adapter, not the Reviewer, owns the final diagnostic command and predicates. Exit code alone does not prove a Finding.",
    "Use evidenceIds only for machine Evidence IDs present in the supplied verification evidence.",
    "Return only structured findings. Do not report provider identity or the reviewed commit; the Harness binds those facts.",
    "Do not vote. For conflicts request evidence or propose a deterministic experiment.",
  ].join("\n");
}

function harnessIdentity(identity: ProviderIdentity): z.infer<typeof reviewerIdentitySchema> {
  return reviewerIdentitySchema.parse({
    provider: identity.provider,
    model: identity.model,
    executable: identity.executable,
    version: identity.version,
  });
}
