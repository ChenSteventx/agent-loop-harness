import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Evidence } from "./domain.js";
import {
  commandReceiptMatchesExecution,
  type CommandReceiptExpectation,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type GitService,
} from "./execution.js";
import { operationInputHash } from "./bindings.js";
import type {
  FindingValidationPlan,
  FindingVerificationRequest,
  ProjectAdapter,
  VerificationCommand,
} from "./ports.js";
import type { Finding } from "./reviewer.js";
import type { TaskSpec } from "./task-spec.js";

export type FindingValidationStatus = "confirmed" | "rejected" | "inconclusive";

export interface PredicateEvaluation {
  expected: {
    exitCode?: number;
    stdoutIncludes?: string;
    stderrIncludes?: string;
  };
  observed: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutSha256: string;
    stderrSha256: string;
    stdoutReceiptMatched: boolean;
    stderrReceiptMatched: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    exitCodeMatched: boolean;
    stdoutMatched: boolean;
    stderrMatched: boolean;
  };
  inconclusive: boolean;
  matched: boolean;
}

export interface FindingValidationDecision {
  findingId: string;
  claimHash: string;
  reviewedCommit: string;
  status: FindingValidationStatus;
  reason: string;
  verificationRequest: FindingVerificationRequest | null;
  validationPlan: FindingValidationPlan | null;
  machineEvidenceIds: string[];
  commandResult: CommandResult | null;
  commandError: string | null;
  predicateEvaluation: PredicateEvaluation | null;
}

export interface FindingValidationInput {
  finding: Finding;
  reviewedCommit: string;
  task: TaskSpec;
  worktreePath: string;
  artifactDirectory: string;
  configurationHash?: string | null;
  evidence: readonly Evidence[];
  git: Pick<GitService, "head" | "isDirty" | "diffHash" | "controlStateHash">;
}

export class FindingValidationBoundaryError extends Error {}

export class FindingValidator {
  constructor(
    private readonly projectAdapter: ProjectAdapter,
    private readonly commandRunner: Pick<CommandRunner, "run" | "configurationBinding" | "receiptExpectation">,
  ) {}

  async validate(input: FindingValidationInput): Promise<FindingValidationDecision> {
    const claimHash = findingClaimHash(input.finding);
    const resolved = resolveValidationPlan(
      this.projectAdapter,
      input.task,
      input.finding,
      input.finding.verificationRequest,
    );
    const decide = (
      status: FindingValidationStatus,
      reason: string,
      override: Partial<Pick<
        FindingValidationDecision,
        "machineEvidenceIds" | "commandResult" | "commandError" | "predicateEvaluation"
      >> = {},
    ) => decision(input, claimHash, status, reason, { ...override, validationPlan: resolved.plan });
    const referenced = input.finding.evidenceIds.map((id) => input.evidence.find((item) => item.id === id));
    const referencesConfirmed = referenced.length > 0 && referenced.every((item) =>
      item !== undefined && evidenceConfirmsFinding(item, input.finding, claimHash, input.reviewedCommit, resolved)
    );
    if (referencesConfirmed) {
      return decide("confirmed", "All cited machine Evidence is bound to this Finding claim", {
        machineEvidenceIds: [...input.finding.evidenceIds],
      });
    }
    if (!resolved.allowed || !resolved.plan || !input.finding.verificationRequest) {
      return decide("inconclusive", resolved.reason);
    }
    const request = commandRequest(
      resolved.plan.command,
      input.worktreePath,
      input.artifactDirectory,
      this.projectAdapter.policyVersion,
      input.configurationHash ?? null,
    );
    let expectation: CommandReceiptExpectation;
    try {
      expectation = this.commandRunner.receiptExpectation(request);
    } catch (error) {
      return decide("inconclusive", "OCI containment is not configured for the diagnostic command", {
        commandError: errorMessage(error),
      });
    }

    const before = gitBoundary(input.git);
    let commandResult: CommandResult;
    try {
      commandResult = await this.commandRunner.run(request);
    } catch (error) {
      return decide("inconclusive", "The approved diagnostic command could not be executed", {
        commandError: errorMessage(error),
      });
    }
    if (!sameGitBoundary(before, gitBoundary(input.git))) {
      throw new FindingValidationBoundaryError(
        "Finding diagnostic command changed the reviewed worktree or Git control state",
      );
    }

    const stdout = artifactText(commandResult.stdoutPath);
    const stderr = artifactText(commandResult.stderrPath);
    if (expectation.sourceCommit !== input.reviewedCommit) {
      return decide("inconclusive", "The diagnostic receipt expectation is not bound to the reviewed commit", {
        commandResult,
      });
    }
    const predicateEvaluation = evaluatePredicate(
      resolved.plan.expected,
      commandResult,
      stdout,
      stderr,
      expectation,
    );
    if (!commandReceiptMatchesExecution(commandResult, expectation)) {
      return decide("inconclusive", "The diagnostic process receipt is incomplete or stale", {
        commandResult,
        predicateEvaluation,
      });
    }
    if (predicateEvaluation.inconclusive) {
      return decide(
        "inconclusive",
        predicateEvaluation.observed.stdoutReceiptMatched && predicateEvaluation.observed.stderrReceiptMatched
          ? "A required output predicate was not observed because the diagnostic output was truncated"
          : "The diagnostic output no longer matches the hashes in its process receipt",
        { commandResult, predicateEvaluation },
      );
    }
    return decide(
      predicateEvaluation.matched ? "confirmed" : "rejected",
      predicateEvaluation.matched
        ? "The Project Adapter validation plan satisfied every structured predicate"
        : "The Project Adapter validation plan did not satisfy every structured predicate",
      { commandResult, predicateEvaluation },
    );
  }
}

export function findingClaimHash(finding: Pick<Finding, "category" | "severity" | "claim" | "location">): string {
  return operationInputHash({
    category: finding.category,
    severity: finding.severity,
    claim: finding.claim,
    location: finding.location,
  });
}

export function isBoundFindingValidationDecision(
  value: unknown,
  expected: { findingId: string; claimHash: string; reviewedCommit: string },
): value is FindingValidationDecision {
  return isRecord(value) &&
    value.findingId === expected.findingId &&
    value.claimHash === expected.claimHash &&
    value.reviewedCommit === expected.reviewedCommit &&
    (value.status === "confirmed" || value.status === "rejected" || value.status === "inconclusive") &&
    typeof value.reason === "string" &&
    Array.isArray(value.machineEvidenceIds) &&
    value.machineEvidenceIds.every((id) => typeof id === "string");
}

interface ResolvedValidationPlan {
  allowed: boolean;
  reason: string;
  plan: FindingValidationPlan | null;
}

function resolveValidationPlan(
  adapter: ProjectAdapter,
  task: TaskSpec,
  finding: Finding,
  request: FindingVerificationRequest | null,
): ResolvedValidationPlan {
  if (!request) return { allowed: false, reason: "The Finding has no machine verification request", plan: null };
  let plan: FindingValidationPlan | null;
  try {
    plan = adapter.resolveFindingValidation?.({
      task,
      finding: {
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        claim: finding.claim,
        location: finding.location,
      },
      request,
    }) ?? null;
  } catch {
    return {
      allowed: false,
      reason: "The Project Adapter could not resolve a Finding validation plan",
      plan: null,
    };
  }
  if (!plan) {
    return {
      allowed: false,
      reason: "The Project Adapter did not provide a Finding validation plan",
      plan: null,
    };
  }
  if (plan.diagnosticSafe !== true) {
    return {
      allowed: false,
      reason: "The Project Adapter validation plan is not explicitly diagnostic-safe",
      plan: null,
    };
  }
  if (!validValidationPlan(plan)) {
    return { allowed: false, reason: "The Project Adapter returned an invalid Finding validation plan", plan: null };
  }
  if (plan.expected.stdoutIncludes === undefined && plan.expected.stderrIncludes === undefined) {
    return {
      allowed: false,
      reason: "Exit code alone cannot confirm a Finding; the Project Adapter plan requires an output predicate",
      plan: null,
    };
  }
  return {
    allowed: true,
    reason: "Project Adapter supplied the diagnostic-safe command and predicate",
    plan,
  };
}

function evidenceConfirmsFinding(
  evidence: Evidence,
  finding: Finding,
  claimHash: string,
  reviewedCommit: string,
  resolved: ResolvedValidationPlan,
): boolean {
  if (evidence.status !== "valid" || evidence.commitSha !== reviewedCommit || !isRecord(evidence.data)) return false;
  if (evidence.kind === "finding_validation") {
    return evidence.data.findingId === finding.id &&
      evidence.data.claimHash === claimHash &&
      evidence.data.reviewedCommit === reviewedCommit &&
      evidence.data.status === "confirmed";
  }
  if (evidence.kind !== "verification_failure" || !resolved.allowed || !resolved.plan) return false;
  const { command, expected } = resolved.plan;
  if (
    evidence.stepId !== `verification-failure:${command.id}` ||
    evidence.data.commandId !== command.id ||
    !sameArgvValue(evidence.data.argv, command.argv) ||
    !isRecord(evidence.data.result) ||
    typeof evidence.data.stdout !== "string" ||
    typeof evidence.data.stderr !== "string"
  ) return false;
  const expectation = commandReceiptExpectationFromValue(evidence.data.receiptExpectation);
  if (!expectation || expectation.sourceCommit !== reviewedCommit ||
      expectation.policyVersion !== evidence.policyVersion ||
      !sameArgvValue(expectation.argv, command.argv)) return false;
  const result = commandResultFromEvidence(evidence.data.result, expectation);
  return result !== null && evaluatePredicate(
    expected,
    result,
    evidence.data.stdout,
    evidence.data.stderr,
    expectation,
  ).matched;
}

function evaluatePredicate(
  expected: FindingValidationPlan["expected"],
  result: CommandResult,
  stdout: string,
  stderr: string,
  expectation: CommandReceiptExpectation,
): PredicateEvaluation {
  const exitCodeMatched = expected.exitCode === undefined || result.exitCode === expected.exitCode;
  const stdoutMatched = expected.stdoutIncludes === undefined || stdout.includes(expected.stdoutIncludes);
  const stderrMatched = expected.stderrIncludes === undefined || stderr.includes(expected.stderrIncludes);
  const stdoutSha256 = sha256(stdout);
  const stderrSha256 = sha256(stderr);
  const stdoutReceiptMatched = stdoutSha256 === result.stdoutHash;
  const stderrReceiptMatched = stderrSha256 === result.stderrHash;
  const inconclusive = !stdoutReceiptMatched || !stderrReceiptMatched || (
    expected.stdoutIncludes !== undefined && !stdoutMatched && result.stdoutTruncated
  ) || (
    expected.stderrIncludes !== undefined && !stderrMatched && result.stderrTruncated
  );
  const receiptMatched = commandReceiptMatchesExecution(result, expectation);
  return {
    expected: {
      ...(expected.exitCode === undefined ? {} : { exitCode: expected.exitCode }),
      ...(expected.stdoutIncludes === undefined ? {} : { stdoutIncludes: expected.stdoutIncludes }),
      ...(expected.stderrIncludes === undefined ? {} : { stderrIncludes: expected.stderrIncludes }),
    },
    observed: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutSha256,
      stderrSha256,
      stdoutReceiptMatched,
      stderrReceiptMatched,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      exitCodeMatched,
      stdoutMatched,
      stderrMatched,
    },
    inconclusive,
    matched: !inconclusive && receiptMatched && exitCodeMatched && stdoutMatched && stderrMatched,
  };
}

function decision(
  input: FindingValidationInput,
  claimHash: string,
  status: FindingValidationStatus,
  reason: string,
  override: Partial<Pick<
    FindingValidationDecision,
    "validationPlan" | "machineEvidenceIds" | "commandResult" | "commandError" | "predicateEvaluation"
  >> = {},
): FindingValidationDecision {
  return {
    findingId: input.finding.id,
    claimHash,
    reviewedCommit: input.reviewedCommit,
    status,
    reason,
    verificationRequest: input.finding.verificationRequest,
    validationPlan: override.validationPlan ?? null,
    machineEvidenceIds: override.machineEvidenceIds ?? [],
    commandResult: override.commandResult ?? null,
    commandError: override.commandError ?? null,
    predicateEvaluation: override.predicateEvaluation ?? null,
  };
}

function validValidationPlan(plan: FindingValidationPlan): boolean {
  return typeof plan.id === "string" && plan.id.trim().length > 0 &&
    typeof plan.command?.id === "string" && plan.command.id.trim().length > 0 &&
    Array.isArray(plan.command.argv) && plan.command.argv.length > 0 &&
    plan.command.argv.every((part) => typeof part === "string" && part.length > 0) &&
    isRecord(plan.expected) &&
    (plan.expected.exitCode === undefined || Number.isSafeInteger(plan.expected.exitCode)) &&
    (plan.expected.stdoutIncludes === undefined || plan.expected.stdoutIncludes.length > 0) &&
    (plan.expected.stderrIncludes === undefined || plan.expected.stderrIncludes.length > 0);
}

function commandRequest(
  command: VerificationCommand,
  cwd: string,
  artifactDirectory: string,
  policyVersion: string,
  configurationHash: string | null,
): CommandRequest {
  return {
    argv: command.argv,
    cwd,
    artifactDirectory,
    environmentAllowlist: ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"],
    timeoutMs: 60_000,
    outputLimitBytes: 1024 * 1024,
    shell: false,
    policyVersion,
    configurationHash,
  };
}

function commandResultFromEvidence(
  value: Record<string, unknown>,
  expectation: CommandReceiptExpectation,
): CommandResult | null {
  return commandReceiptMatchesExecution(value, expectation) ? value : null;
}

function commandReceiptExpectationFromValue(value: unknown): CommandReceiptExpectation | null {
  if (!isRecord(value) || !Array.isArray(value.argv) ||
      value.argv.some((part) => typeof part !== "string")) return null;
  return value as unknown as CommandReceiptExpectation;
}

function gitBoundary(git: FindingValidationInput["git"]): Record<string, string | boolean> {
  return {
    head: git.head(),
    dirty: git.isDirty(),
    diffHash: git.diffHash(),
    controlStateHash: git.controlStateHash(),
  };
}

function sameGitBoundary(left: Record<string, string | boolean>, right: Record<string, string | boolean>): boolean {
  return operationInputHash(left) === operationInputHash(right);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameArgvValue(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every((part) => typeof part === "string") && sameArgv(value, expected);
}

function artifactText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
