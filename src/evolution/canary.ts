import { createHash } from "node:crypto";
import type { OfflineComparison } from "../evaluation/compare.js";
import type { ReadinessReport } from "../evaluation/readiness.js";
import type { ChangeProposal, ConfigurationVariant, EvolutionTarget, RollbackDecision } from "./proposals.js";

const canaryEligibleTargets: readonly EvolutionTarget[] = [
  "prompt-variant",
  "context-ranking",
  "provider-routing",
  "retry-policy",
  "timeout-policy",
  "low-risk-review-rubric",
  "memory-retrieval",
];

export interface CanaryApproval {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  proposalId: string;
  challengerId: string;
  allowedRisk: "low";
  maximumBasisPoints: number;
  maximumTasks: number;
  maximumExtraBudgetTokens: number;
  authority: "human";
  approvedBy: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export interface CanaryPolicy {
  enabled: boolean;
  basisPoints: number;
  hashSalt: string;
  projectAllowlist: string[];
  maxTasks: number;
  windowStartsAt: string;
  windowEndsAt: string;
  extraBudgetTokens: number;
}

export const disabledCanaryPolicy: CanaryPolicy = {
  enabled: false,
  basisPoints: 0,
  hashSalt: "agent-loop-canary-v1",
  projectAllowlist: [],
  maxTasks: 0,
  windowStartsAt: "1970-01-01T00:00:00.000Z",
  windowEndsAt: "1970-01-01T00:00:00.000Z",
  extraBudgetTokens: 0,
};

export interface CanaryAssignment {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  taskKey: string;
  risk: "low" | "medium" | "high" | "unknown";
  proposalId: string;
  championId: string;
  challengerId: string;
  selectedVariantId: string;
  selected: "champion" | "challenger";
  bucket: number;
  basisPoints: number;
  extraBudgetTokens: number;
  reason: string;
  createdAt: string;
}

export interface CanaryObservation {
  schemaVersion: 1;
  id: string;
  assignmentId: string;
  formalRunId: string;
  factHash: string;
  ready: boolean;
  done: boolean;
  verificationFailures: number;
  guardrailViolation: boolean;
  rollbackDecisionId: string | null;
  createdAt: string;
}

export interface CanaryRepository {
  installCanaryApproval(approval: CanaryApproval): CanaryApproval;
  installCanaryAssignment(assignment: CanaryAssignment): CanaryAssignment;
  applyCanaryObservation(observation: CanaryObservation, rollback: RollbackDecision | null): CanaryObservation;
  countCanaryAssignments(projectScope: string, proposalId: string): number;
}

export function createCanaryApproval(input: {
  id: string;
  projectScope: string;
  proposal: ChangeProposal;
  challenger: ConfigurationVariant;
  maximumBasisPoints: number;
  maximumTasks: number;
  maximumExtraBudgetTokens: number;
  approvedBy: string;
  reason: string;
  createdAt?: string;
  expiresAt: string;
}): CanaryApproval {
  if (input.proposal.status !== "evaluated" || input.challenger.status !== "challenger" ||
      input.challenger.proposalId !== input.proposal.id || input.challenger.projectScope !== input.projectScope) {
    throw new Error("Canary approval requires an evaluated Proposal and matching Challenger");
  }
  if (!Number.isSafeInteger(input.maximumBasisPoints) || input.maximumBasisPoints <= 0 || input.maximumBasisPoints > 1_000) {
    throw new Error("Canary approval maximum must be between 1 and 1000 basis points");
  }
  if (!Number.isSafeInteger(input.maximumTasks) || input.maximumTasks <= 0 ||
      !Number.isSafeInteger(input.maximumExtraBudgetTokens) || input.maximumExtraBudgetTokens < 0) {
    throw new Error("Canary approval requires bounded task and extra-budget limits");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (input.expiresAt <= createdAt) throw new Error("Canary approval must expire after it is created");
  return {
    schemaVersion: 1,
    id: requiredText(input.id, "Canary Approval id"),
    projectScope: requiredText(input.projectScope, "project scope"),
    proposalId: input.proposal.id,
    challengerId: input.challenger.id,
    allowedRisk: "low",
    maximumBasisPoints: input.maximumBasisPoints,
    maximumTasks: input.maximumTasks,
    maximumExtraBudgetTokens: input.maximumExtraBudgetTokens,
    authority: "human",
    approvedBy: requiredText(input.approvedBy, "human approver"),
    reason: requiredText(input.reason, "approval reason"),
    createdAt,
    expiresAt: input.expiresAt,
  };
}

export function assignCanary(
  repository: CanaryRepository,
  input: {
    id: string;
    projectScope: string;
    taskKey: string;
    risk: CanaryAssignment["risk"];
    proposal: ChangeProposal;
    champion: ConfigurationVariant;
    challenger: ConfigurationVariant;
    comparison: OfflineComparison;
    readiness: ReadinessReport;
    approval: CanaryApproval | null;
    policy?: CanaryPolicy;
    createdAt?: string;
  },
): CanaryAssignment {
  const policy = input.policy ?? disabledCanaryPolicy;
  const createdAt = input.createdAt ?? new Date().toISOString();
  validatePolicy(policy);
  validateBindings(input);
  const bucket = stableCanaryBucket(input.projectScope, input.taskKey, input.proposal.id, policy.hashSalt);
  let selected: CanaryAssignment["selected"] = "champion";
  let reason = "Canary is disabled";
  if (policy.enabled) {
    if (input.risk !== "low") reason = "Only low-risk tasks are eligible for Canary";
    else if (!canaryEligibleTargets.includes(input.proposal.target)) reason = "Proposal target is not eligible for Canary";
    else if (!policy.projectAllowlist.includes(input.projectScope)) reason = "Project is not in the Canary allowlist";
    else if (createdAt < policy.windowStartsAt || createdAt >= policy.windowEndsAt) reason = "Canary is outside its approved time window";
    else if (!input.readiness.canaryReady) reason = "Canary Readiness is not satisfied";
    else if (!input.approval || input.approval.expiresAt <= createdAt || input.approval.authority !== "human" ||
        input.approval.projectScope !== input.projectScope || input.approval.proposalId !== input.proposal.id ||
        input.approval.challengerId !== input.challenger.id) reason = "Valid human Canary approval is missing";
    else if (policy.basisPoints > input.approval.maximumBasisPoints) reason = "Canary percentage exceeds human approval";
    else if (policy.maxTasks > input.approval.maximumTasks ||
        repository.countCanaryAssignments(input.projectScope, input.proposal.id) >= policy.maxTasks) {
      reason = "Canary task limit is exhausted or exceeds human approval";
    } else if (policy.extraBudgetTokens > input.approval.maximumExtraBudgetTokens) {
      reason = "Canary extra budget exceeds human approval";
    }
    else if (input.comparison.status !== "completed" || !input.comparison.guardrailsSatisfied) {
      reason = "Offline Comparison guardrails are not satisfied";
    } else if (bucket >= policy.basisPoints) reason = "Stable hash selected the Champion cohort";
    else {
      selected = "challenger";
      reason = "All low-risk Canary gates passed and stable hash selected the Challenger cohort";
    }
  }
  return repository.installCanaryAssignment({
    schemaVersion: 1,
    id: requiredText(input.id, "Canary Assignment id"),
    projectScope: input.projectScope,
    taskKey: requiredText(input.taskKey, "Canary task key"),
    risk: input.risk,
    proposalId: input.proposal.id,
    championId: input.champion.id,
    challengerId: input.challenger.id,
    selectedVariantId: selected === "challenger" ? input.challenger.id : input.champion.id,
    selected,
    bucket,
    basisPoints: policy.basisPoints,
    extraBudgetTokens: policy.extraBudgetTokens,
    reason,
    createdAt,
  });
}

export function recordCanaryObservation(
  repository: CanaryRepository,
  input: {
    id: string;
    assignment: CanaryAssignment;
    formalRunId: string;
    factHash: string;
    ready: boolean;
    done: boolean;
    verificationFailures: number;
    createdAt?: string;
  },
): CanaryObservation {
  if (!Number.isSafeInteger(input.verificationFailures) || input.verificationFailures < 0) {
    throw new Error("Canary verification failure count must be non-negative");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  const guardrailViolation = input.assignment.selected === "challenger" &&
    (!input.ready || input.verificationFailures > 0);
  const rollbackDecisionId = guardrailViolation ? `${input.id}:rollback` : null;
  const decision: RollbackDecision | null = guardrailViolation
    ? {
      schemaVersion: 1,
      id: rollbackDecisionId!,
      projectScope: input.assignment.projectScope,
      fromChampionId: input.assignment.challengerId,
      restoreChampionId: input.assignment.championId,
      reason: "Canary guardrail detected a ready failure or verification regression",
      triggerEvidenceHash: requiredText(input.factHash, "Canary fact hash"),
      authority: "automatic-guardrail",
      decidedBy: "canary-guardrail",
      decidedAt: createdAt,
    }
    : null;
  return repository.applyCanaryObservation({
    schemaVersion: 1,
    id: requiredText(input.id, "Canary Observation id"),
    assignmentId: input.assignment.id,
    formalRunId: requiredText(input.formalRunId, "formal Run id"),
    factHash: requiredText(input.factHash, "Canary fact hash"),
    ready: input.ready,
    done: input.done,
    verificationFailures: input.verificationFailures,
    guardrailViolation,
    rollbackDecisionId,
    createdAt,
  }, decision);
}

export function stableCanaryBucket(projectScope: string, taskKey: string, proposalId: string, salt: string): number {
  const hash = createHash("sha256").update(`${projectScope}\0${taskKey}\0${proposalId}\0${salt}`).digest();
  return hash.readUInt32BE(0) % 10_000;
}

function validatePolicy(policy: CanaryPolicy): void {
  if (!Number.isSafeInteger(policy.basisPoints) || policy.basisPoints < 0 || policy.basisPoints > 1_000 ||
      !Number.isSafeInteger(policy.maxTasks) || policy.maxTasks < 0 ||
      !Number.isSafeInteger(policy.extraBudgetTokens) || policy.extraBudgetTokens < 0 ||
      !policy.hashSalt.trim() || policy.projectAllowlist.some((scope) => !scope.trim()) ||
      (policy.enabled && (policy.maxTasks === 0 || policy.windowEndsAt <= policy.windowStartsAt)) ||
      (!policy.enabled && (policy.basisPoints !== 0 || policy.maxTasks !== 0 || policy.extraBudgetTokens !== 0))) {
    throw new Error("Canary Policy must be disabled at zero or bounded to at most 10 percent");
  }
}

function validateBindings(input: {
  projectScope: string;
  proposal: ChangeProposal;
  champion: ConfigurationVariant;
  challenger: ConfigurationVariant;
  comparison: OfflineComparison;
}): void {
  if (input.proposal.projectScope !== input.projectScope || input.champion.projectScope !== input.projectScope ||
      input.challenger.projectScope !== input.projectScope || input.comparison.projectScope !== input.projectScope ||
      input.proposal.id !== input.challenger.proposalId || input.proposal.id !== input.comparison.proposalId ||
      input.champion.id !== input.comparison.championId || input.challenger.id !== input.comparison.challengerId) {
    throw new Error("Canary bindings do not match Proposal, variants, and Offline Comparison");
  }
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
