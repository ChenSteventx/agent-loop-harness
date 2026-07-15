import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Evidence } from "./domain.js";
import type { CommandRequest, CommandResult, CommandRunner, GitService } from "./execution.js";
import { operationInputHash } from "./bindings.js";
import type { FindingVerificationRequest, ProjectAdapter, VerificationCommand } from "./ports.js";
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
    exitCodeMatched: boolean;
    stdoutMatched: boolean;
    stderrMatched: boolean;
  };
  matched: boolean;
}

export interface FindingValidationDecision {
  findingId: string;
  claimHash: string;
  reviewedCommit: string;
  status: FindingValidationStatus;
  reason: string;
  verificationRequest: FindingVerificationRequest | null;
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
  evidence: readonly Evidence[];
  git: Pick<GitService, "head" | "isDirty" | "diffHash" | "controlStateHash">;
}

export class FindingValidationBoundaryError extends Error {}

export class FindingValidator {
  constructor(
    private readonly projectAdapter: ProjectAdapter,
    private readonly commandRunner: Pick<CommandRunner, "run">,
  ) {}

  async validate(input: FindingValidationInput): Promise<FindingValidationDecision> {
    const claimHash = findingClaimHash(input.finding);
    const resolved = resolveVerificationRequest(this.projectAdapter, input.task, input.finding.verificationRequest);
    const referenced = input.finding.evidenceIds.map((id) => input.evidence.find((item) => item.id === id));
    const referencesConfirmed = referenced.length > 0 && referenced.every((item) =>
      item !== undefined && evidenceConfirmsFinding(item, input.finding, claimHash, input.reviewedCommit, resolved)
    );
    if (referencesConfirmed) {
      return decision(input, claimHash, "confirmed", "All cited machine Evidence is bound to this Finding claim", {
        machineEvidenceIds: [...input.finding.evidenceIds],
      });
    }
    if (!resolved.allowed || !resolved.command || !input.finding.verificationRequest) {
      return decision(input, claimHash, "inconclusive", resolved.reason);
    }

    const before = gitBoundary(input.git);
    let commandResult: CommandResult;
    try {
      commandResult = await this.commandRunner.run(commandRequest(
        resolved.command,
        input.worktreePath,
        input.artifactDirectory,
      ));
    } catch (error) {
      return decision(input, claimHash, "inconclusive", "The approved diagnostic command could not be executed", {
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
    const predicateEvaluation = evaluatePredicate(
      input.finding.verificationRequest,
      commandResult,
      stdout,
      stderr,
      input.reviewedCommit,
    );
    if (commandResult.signal !== null || commandResult.timedOut || commandResult.commitBefore !== input.reviewedCommit) {
      return decision(input, claimHash, "inconclusive", "The diagnostic process receipt is incomplete or stale", {
        commandResult,
        predicateEvaluation,
      });
    }
    return decision(
      input,
      claimHash,
      predicateEvaluation.matched ? "confirmed" : "rejected",
      predicateEvaluation.matched
        ? "The approved diagnostic command satisfied every structured predicate"
        : "The approved diagnostic command did not satisfy every structured predicate",
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

interface ResolvedVerificationRequest {
  allowed: boolean;
  reason: string;
  command: VerificationCommand | null;
  request: FindingVerificationRequest | null;
}

function resolveVerificationRequest(
  adapter: ProjectAdapter,
  task: TaskSpec,
  request: FindingVerificationRequest | null,
): ResolvedVerificationRequest {
  if (!request) return { allowed: false, reason: "The Finding has no machine verification request", command: null, request };
  if (request.stdoutIncludes === undefined && request.stderrIncludes === undefined) {
    return {
      allowed: false,
      reason: "Exit code alone cannot confirm a Finding; an output predicate is required",
      command: null,
      request,
    };
  }
  const declared = adapter.verificationCommands(task);
  const byStep = request.verificationStepId
    ? declared.find((command) => command.id === request.verificationStepId)
    : undefined;
  const byArgv = request.proposedArgv
    ? declared.find((command) => sameArgv(command.argv, request.proposedArgv!))
    : undefined;
  const command = byStep ?? byArgv;
  if (command && request.proposedArgv && !sameArgv(command.argv, request.proposedArgv)) {
    return {
      allowed: false,
      reason: "The proposed argv does not match the declared verification step",
      command: null,
      request,
    };
  }
  if (command) return { allowed: true, reason: "Declared Project Adapter verification command", command, request };
  if (request.proposedArgv && adapter.allowDiagnosticCommand?.(request) === true) {
    return {
      allowed: true,
      reason: "Project Adapter explicitly allowed the diagnostic command",
      command: { id: request.verificationStepId ?? "project-adapter-diagnostic", argv: request.proposedArgv },
      request,
    };
  }
  return {
    allowed: false,
    reason: "The diagnostic command is not declared or explicitly allowed by the Project Adapter",
    command: null,
    request,
  };
}

function evidenceConfirmsFinding(
  evidence: Evidence,
  finding: Finding,
  claimHash: string,
  reviewedCommit: string,
  resolved: ResolvedVerificationRequest,
): boolean {
  if (evidence.status !== "valid" || evidence.commitSha !== reviewedCommit || !isRecord(evidence.data)) return false;
  if (evidence.kind === "finding_validation") {
    return evidence.data.findingId === finding.id &&
      evidence.data.claimHash === claimHash &&
      evidence.data.reviewedCommit === reviewedCommit &&
      evidence.data.status === "confirmed";
  }
  if (evidence.kind !== "verification_failure" || !resolved.allowed || !resolved.command || !resolved.request) return false;
  if (
    evidence.stepId !== `verification-failure:${resolved.command.id}` ||
    evidence.data.commandId !== resolved.command.id ||
    !sameArgvValue(evidence.data.argv, resolved.command.argv) ||
    !isRecord(evidence.data.result) ||
    typeof evidence.data.stdout !== "string" ||
    typeof evidence.data.stderr !== "string"
  ) return false;
  const result = commandResultFromEvidence(evidence.data.result, resolved.command.argv);
  return result !== null && evaluatePredicate(
    resolved.request,
    result,
    evidence.data.stdout,
    evidence.data.stderr,
    reviewedCommit,
  ).matched;
}

function evaluatePredicate(
  request: FindingVerificationRequest,
  result: CommandResult,
  stdout: string,
  stderr: string,
  reviewedCommit: string,
): PredicateEvaluation {
  const exitCodeMatched = request.expectedExitCode === undefined || result.exitCode === request.expectedExitCode;
  const stdoutMatched = request.stdoutIncludes === undefined || stdout.includes(request.stdoutIncludes);
  const stderrMatched = request.stderrIncludes === undefined || stderr.includes(request.stderrIncludes);
  const receiptMatched = result.commitBefore === reviewedCommit && result.signal === null && !result.timedOut;
  return {
    expected: {
      ...(request.expectedExitCode === undefined ? {} : { exitCode: request.expectedExitCode }),
      ...(request.stdoutIncludes === undefined ? {} : { stdoutIncludes: request.stdoutIncludes }),
      ...(request.stderrIncludes === undefined ? {} : { stderrIncludes: request.stderrIncludes }),
    },
    observed: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      exitCodeMatched,
      stdoutMatched,
      stderrMatched,
    },
    matched: receiptMatched && exitCodeMatched && stdoutMatched && stderrMatched,
  };
}

function decision(
  input: FindingValidationInput,
  claimHash: string,
  status: FindingValidationStatus,
  reason: string,
  override: Partial<Pick<FindingValidationDecision, "machineEvidenceIds" | "commandResult" | "commandError" | "predicateEvaluation">> = {},
): FindingValidationDecision {
  return {
    findingId: input.finding.id,
    claimHash,
    reviewedCommit: input.reviewedCommit,
    status,
    reason,
    verificationRequest: input.finding.verificationRequest,
    machineEvidenceIds: override.machineEvidenceIds ?? [],
    commandResult: override.commandResult ?? null,
    commandError: override.commandError ?? null,
    predicateEvaluation: override.predicateEvaluation ?? null,
  };
}

function commandRequest(command: VerificationCommand, cwd: string, artifactDirectory: string): CommandRequest {
  return {
    argv: command.argv,
    cwd,
    artifactDirectory,
    environmentAllowlist: ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"],
    timeoutMs: 60_000,
    outputLimitBytes: 1024 * 1024,
    shell: false,
  };
}

function commandResultFromEvidence(value: Record<string, unknown>, argv: readonly string[]): CommandResult | null {
  if (
    !sameArgvValue(value.argv, argv) ||
    typeof value.cwd !== "string" ||
    !(typeof value.exitCode === "number" || value.exitCode === null) ||
    !(typeof value.signal === "string" || value.signal === null) ||
    typeof value.durationMs !== "number" ||
    typeof value.timedOut !== "boolean" ||
    typeof value.stdoutPath !== "string" ||
    typeof value.stderrPath !== "string" ||
    typeof value.stdoutTruncated !== "boolean" ||
    typeof value.stderrTruncated !== "boolean" ||
    typeof value.commitBefore !== "string"
  ) return null;
  return value as unknown as CommandResult;
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
