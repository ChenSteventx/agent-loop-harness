import { operationInputHash } from "../bindings.js";
import type { RunBinding } from "../domain.js";
import type { DatasetKind } from "./datasets.js";
import type { SanitizedFactBundle } from "./facts.js";
import { gradeReplayability, type Replayability } from "./manifests.js";

export type ReplayMode = "full" | "verify-only";
export type EvaluationRunStatus = "completed" | "failed" | "not-replayable";

export interface EvaluationOutcome {
  passed: boolean;
  evidenceHash: string | null;
  diagnostics: string[];
}

export interface EvaluationRun {
  schemaVersion: 1;
  id: string;
  sourceRunId: string;
  sourceFactHash: string;
  mode: ReplayMode;
  datasetPartition: DatasetKind;
  championVersion: string;
  challengerVersion: string | null;
  evaluatorKind: "verify-only" | "full-task-replay";
  evaluatorVersion: string;
  dataSource: "real" | "fixture";
  configurationVariantId: string | null;
  configurationHash: string | null;
  resultArtifactHash: string | null;
  replayability: Replayability;
  status: EvaluationRunStatus;
  verificationCommit: string | null;
  verificationBindingHash: string | null;
  missingInputs: string[];
  outcome: EvaluationOutcome | null;
  createdAt: string;
}

export interface EvaluationRunRepository {
  installEvaluationRun(run: EvaluationRun): EvaluationRun;
}

export type ReplayExecutor = (
  facts: SanitizedFactBundle,
  mode: ReplayMode,
  binding: RunBinding,
) => Promise<EvaluationOutcome>;

export class HistoricalReplay {
  constructor(
    private readonly repository: EvaluationRunRepository,
    private readonly executor: ReplayExecutor,
  ) {}

  async run(input: {
    id: string;
    facts: SanitizedFactBundle;
    binding: RunBinding | null;
    mode: ReplayMode;
    datasetPartition?: DatasetKind;
    championVersion?: string;
    challengerVersion?: string | null;
    evaluatorKind?: EvaluationRun["evaluatorKind"];
    evaluatorVersion?: string;
    configurationVariantId?: string | null;
    configurationHash?: string | null;
    resultArtifactHash?: string | null;
    requiredOperationIds?: readonly string[];
    createdAt?: string;
  }): Promise<EvaluationRun> {
    const report = gradeReplayability({
      binding: input.binding,
      manifests: input.facts.manifests,
      requiredOperationIds: input.requiredOperationIds,
    });
    const createdAt = input.createdAt ?? new Date().toISOString();
    const verificationCommit = pinnedVerificationCommit(input.facts);
    const verificationBindingHash = input.binding && verificationCommit
      ? boundVerificationHash(input.binding, verificationCommit)
      : null;
    const missingInputs = [...report.missingInputs];
    if (input.mode === "full" && report.grade !== "manifest-complete") {
      missingInputs.push("manifest_complete_replayability");
      return this.repository.installEvaluationRun(baseRun(input, report.grade, "not-replayable", null,
        verificationCommit, verificationBindingHash, unique(missingInputs), createdAt));
    }
    const bound = input.binding !== null && (input.mode === "full"
      ? fullTaskReplayIsBound(input.facts, input.binding)
      : verifyOnlyIsBound(input.facts, input.binding));
    if (!input.binding || !bound) {
      missingInputs.push(input.mode === "full" ? "full_task_replay_binding" : "pinned_verification_binding");
      return this.repository.installEvaluationRun(baseRun(input, report.grade, "not-replayable", null,
        verificationCommit, verificationBindingHash, unique(missingInputs), createdAt));
    }
    try {
      const outcome = await this.executor(input.facts, input.mode, input.binding);
      validateOutcome(outcome);
      return this.repository.installEvaluationRun(baseRun(input, report.grade, "completed", outcome,
        verificationCommit, verificationBindingHash, unique(missingInputs), createdAt));
    } catch (error) {
      return this.repository.installEvaluationRun(baseRun(input, report.grade, "failed", {
        passed: false,
        evidenceHash: null,
        diagnostics: [error instanceof Error ? error.name : "ReplayError"],
      }, verificationCommit, verificationBindingHash, unique(missingInputs), createdAt));
    }
  }
}

export function boundVerificationHash(binding: RunBinding, verificationCommit: string): string {
  return operationInputHash({
    verificationCommit,
    baselineCommit: binding.baselineCommit,
    taskSpecHash: binding.taskSpecHash,
    acceptanceHash: binding.acceptanceHash,
    policyVersion: binding.policyVersion,
    projectAdapterName: binding.projectAdapterName,
    verification: binding.taskSpec.verification,
  });
}

function verifyOnlyIsBound(facts: SanitizedFactBundle, binding: RunBinding): boolean {
  const stored = facts.run.binding;
  return stored !== null &&
    pinnedVerificationCommit(facts) !== null &&
    stored.baselineCommit === binding.baselineCommit &&
    stored.taskSpecHash === binding.taskSpecHash &&
    stored.acceptanceHash === binding.acceptanceHash &&
    stored.policyVersion === binding.policyVersion &&
    stored.projectAdapterName === binding.projectAdapterName &&
    binding.taskSpec.verification.length > 0 &&
    stored.verificationStepIds.length === binding.taskSpec.verification.length &&
    stored.verificationStepIds.every((id, index) => id === binding.taskSpec.verification[index]?.id);
}

function fullTaskReplayIsBound(facts: SanitizedFactBundle, binding: RunBinding): boolean {
  // Unlike verify-only, full replay re-executes the task from the Baseline Commit,
  // so no historical candidate/command evidence (pinned commit) is required —
  // failed, blocked, and no-candidate runs must remain fully replayable.
  const stored = facts.run.binding;
  return stored !== null &&
    stored.baselineCommit === binding.baselineCommit &&
    stored.taskSpecHash === binding.taskSpecHash &&
    stored.acceptanceHash === binding.acceptanceHash &&
    stored.policyVersion === binding.policyVersion &&
    stored.projectAdapterName === binding.projectAdapterName &&
    binding.taskSpec.verification.length > 0 &&
    stored.verificationStepIds.length === binding.taskSpec.verification.length &&
    stored.verificationStepIds.every((id, index) => id === binding.taskSpec.verification[index]?.id);
}

export function pinnedVerificationCommit(facts: SanitizedFactBundle): string | null {
  const command = facts.evidence.find((item) => item.kind === "command" && item.status === "valid");
  const candidate = facts.evidence.find((item) => item.kind === "candidate_commit" && item.status === "valid");
  return command?.commitSha ?? candidate?.commitSha ?? null;
}

function baseRun(
  input: {
    id: string;
    facts: SanitizedFactBundle;
    mode: ReplayMode;
    datasetPartition?: DatasetKind;
    championVersion?: string;
    challengerVersion?: string | null;
    evaluatorKind?: EvaluationRun["evaluatorKind"];
    evaluatorVersion?: string;
    configurationVariantId?: string | null;
    configurationHash?: string | null;
    resultArtifactHash?: string | null;
  },
  replayability: Replayability,
  status: EvaluationRunStatus,
  outcome: EvaluationOutcome | null,
  verificationCommit: string | null,
  verificationBindingHash: string | null,
  missingInputs: string[],
  createdAt: string,
): EvaluationRun {
  if (!input.id.trim()) throw new Error("Evaluation Run id is required");
  return {
    schemaVersion: 1,
    id: input.id,
    sourceRunId: input.facts.run.id,
    sourceFactHash: input.facts.factHash,
    mode: input.mode,
    datasetPartition: input.datasetPartition ?? "historical",
    championVersion: input.championVersion ?? "development-source",
    challengerVersion: input.challengerVersion ?? null,
    evaluatorKind: input.evaluatorKind ?? (input.mode === "full" ? "full-task-replay" : "verify-only"),
    evaluatorVersion: input.evaluatorVersion ?? (input.mode === "full" ? "full-task-replay/v1" : "verify-only/v1"),
    dataSource: input.facts.source,
    configurationVariantId: input.configurationVariantId ?? null,
    configurationHash: input.configurationHash ?? null,
    resultArtifactHash: input.resultArtifactHash ?? outcome?.evidenceHash ?? null,
    replayability,
    status,
    verificationCommit,
    verificationBindingHash,
    missingInputs,
    outcome,
    createdAt,
  };
}

function validateOutcome(outcome: EvaluationOutcome): void {
  if (typeof outcome.passed !== "boolean" ||
      !(outcome.evidenceHash === null || (typeof outcome.evidenceHash === "string" && outcome.evidenceHash.length > 0)) ||
      !Array.isArray(outcome.diagnostics) || outcome.diagnostics.some((item) => typeof item !== "string")) {
    throw new Error("Replay executor returned an invalid Evaluation outcome");
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
