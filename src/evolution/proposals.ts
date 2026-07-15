import { operationInputHash } from "../bindings.js";
import type { EvaluationDataset } from "../evaluation/datasets.js";

export const evolutionTargets = [
  "provider-routing",
  "role-model-selection",
  "retry-policy",
  "timeout-policy",
  "risk-thresholds",
  "memory-retrieval",
] as const;
export type EvolutionTarget = (typeof evolutionTargets)[number];

export interface EvolutionConfiguration {
  providerOrder: string[];
  roleModels: Record<string, string>;
  retryLimit: number;
  timeoutMs: number;
  riskThresholds: { assisted: number; reviewed: number };
  memoryRetrievalEnabled: boolean;
}

export interface EvaluationPlan {
  datasetIds: string[];
  metrics: string[];
  minimumSamples: number;
  guardrails: {
    maximumReadyRegression: number;
    maximumDoneRegression: number;
    maximumVerificationFailureIncrease: number;
  };
}

export interface ChangeProposal {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  target: EvolutionTarget;
  baseChampionId: string;
  patch: Partial<EvolutionConfiguration>;
  rationale: string;
  sourceFactHashes: string[];
  evaluationPlan: EvaluationPlan;
  proposalHash: string;
  status: "draft" | "approved" | "rejected" | "evaluated" | "promoted" | "rolled-back";
  createdAt: string;
  approval: null | {
    authority: "human";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  };
}

export interface ConfigurationVariant {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  proposalId: string | null;
  version: string;
  configuration: EvolutionConfiguration;
  configurationHash: string;
  status: "champion" | "challenger" | "retired" | "rolled-back";
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
}

export interface PromotionDecision {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  proposalId: string;
  fromChampionId: string;
  challengerId: string;
  verdict: "promote" | "reject";
  comparisonId: string;
  thresholdsSatisfied: boolean;
  sampleSize: number;
  authority: "human";
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

export interface RollbackDecision {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  fromChampionId: string;
  restoreChampionId: string;
  reason: string;
  triggerEvidenceHash: string;
  authority: "human" | "automatic-guardrail";
  decidedBy: string;
  decidedAt: string;
}

export interface EvolutionRepository {
  installChangeProposal(proposal: ChangeProposal): ChangeProposal;
  getChangeProposal(id: string): ChangeProposal | null;
  decideChangeProposal(input: {
    id: string;
    status: "approved" | "rejected" | "evaluated";
    authority: "human";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  }): ChangeProposal;
  installConfigurationVariant(variant: ConfigurationVariant): ConfigurationVariant;
  getConfigurationVariant(id: string): ConfigurationVariant | null;
  activeChampion(projectScope: string): ConfigurationVariant | null;
  activateChallenger(decision: PromotionDecision): ConfigurationVariant;
  rollbackChampion(decision: RollbackDecision): ConfigurationVariant;
}

export function createInitialChampion(input: {
  id: string;
  projectScope: string;
  version: string;
  configuration: EvolutionConfiguration;
  createdAt?: string;
}): ConfigurationVariant {
  validateConfiguration(input.configuration);
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    id: requiredText(input.id, "Champion id"),
    projectScope: requiredText(input.projectScope, "project scope"),
    proposalId: null,
    version: requiredText(input.version, "configuration version"),
    configuration: input.configuration,
    configurationHash: operationInputHash(input.configuration),
    status: "champion",
    createdAt,
    activatedAt: createdAt,
    retiredAt: null,
  };
}

export function createChangeProposal(input: {
  id: string;
  projectScope: string;
  target: EvolutionTarget;
  baseChampion: ConfigurationVariant;
  patch: Partial<EvolutionConfiguration>;
  rationale: string;
  sourceFactHashes: readonly string[];
  datasets: readonly EvaluationDataset[];
  metrics: readonly string[];
  minimumSamples: number;
  createdAt?: string;
}): ChangeProposal {
  if (!evolutionTargets.includes(input.target)) throw new Error(`Forbidden evolution target: ${String(input.target)}`);
  if (input.baseChampion.status !== "champion" || input.baseChampion.projectScope !== input.projectScope) {
    throw new Error("Change Proposal must bind the active project Champion");
  }
  if (input.datasets.some((dataset) => dataset.kind === "holdout")) {
    throw new Error("Proposal generation cannot access Holdout Tasks");
  }
  validatePatch(input.target, input.patch);
  const sourceFactHashes = [...new Set(input.sourceFactHashes)].sort();
  if (sourceFactHashes.length === 0) throw new Error("Change Proposal requires source facts");
  if (!Number.isSafeInteger(input.minimumSamples) || input.minimumSamples <= 0) {
    throw new Error("Evaluation Plan minimumSamples must be positive");
  }
  const evaluationPlan: EvaluationPlan = {
    datasetIds: input.datasets.map((dataset) => dataset.id).sort(),
    metrics: [...new Set(input.metrics)].sort(),
    minimumSamples: input.minimumSamples,
    guardrails: {
      maximumReadyRegression: 0,
      maximumDoneRegression: 0,
      maximumVerificationFailureIncrease: 0,
    },
  };
  if (evaluationPlan.datasetIds.length === 0 || evaluationPlan.metrics.length === 0) {
    throw new Error("Evaluation Plan requires datasets and metrics");
  }
  const body = {
    projectScope: input.projectScope,
    target: input.target,
    baseChampionId: input.baseChampion.id,
    patch: input.patch,
    rationale: requiredText(input.rationale, "proposal rationale"),
    sourceFactHashes,
    evaluationPlan,
  };
  return {
    schemaVersion: 1,
    id: requiredText(input.id, "Proposal id"),
    ...body,
    proposalHash: operationInputHash(body),
    status: "draft",
    createdAt: input.createdAt ?? new Date().toISOString(),
    approval: null,
  };
}

export function approveChangeProposal(
  repository: EvolutionRepository,
  input: { id: string; approvedBy: string; reason: string; decidedAt?: string },
): ChangeProposal {
  return repository.decideChangeProposal({
    id: input.id,
    status: "approved",
    authority: "human",
    decidedBy: requiredText(input.approvedBy, "human approver"),
    reason: requiredText(input.reason, "approval reason"),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  });
}

export function createChallenger(input: {
  id: string;
  version: string;
  proposal: ChangeProposal;
  champion: ConfigurationVariant;
  createdAt?: string;
}): ConfigurationVariant {
  if (input.proposal.status !== "approved" && input.proposal.status !== "evaluated") {
    throw new Error("Only an approved Change Proposal can create a Challenger");
  }
  if (input.champion.id !== input.proposal.baseChampionId || input.champion.status !== "champion") {
    throw new Error("Challenger base Champion does not match its Change Proposal");
  }
  const configuration = { ...input.champion.configuration, ...input.proposal.patch };
  validateConfiguration(configuration);
  return {
    schemaVersion: 1,
    id: requiredText(input.id, "Challenger id"),
    projectScope: input.proposal.projectScope,
    proposalId: input.proposal.id,
    version: requiredText(input.version, "Challenger version"),
    configuration,
    configurationHash: operationInputHash(configuration),
    status: "challenger",
    createdAt: input.createdAt ?? new Date().toISOString(),
    activatedAt: null,
    retiredAt: null,
  };
}

export function promoteChallenger(
  repository: EvolutionRepository,
  input: Omit<PromotionDecision, "schemaVersion" | "authority">,
): ConfigurationVariant {
  requiredText(input.id, "Promotion Decision id");
  requiredText(input.comparisonId, "offline comparison id");
  requiredText(input.decidedBy, "human decision maker");
  requiredText(input.reason, "promotion reason");
  const proposal = repository.getChangeProposal(input.proposalId);
  const challenger = repository.getConfigurationVariant(input.challengerId);
  const champion = repository.activeChampion(input.projectScope);
  if (!proposal || !challenger || !champion) throw new Error("Promotion facts are incomplete");
  if (!Number.isSafeInteger(input.sampleSize) || input.verdict !== "promote" || !input.thresholdsSatisfied ||
      input.sampleSize < proposal.evaluationPlan.minimumSamples) {
    throw new Error("Challenger cannot be promoted without satisfied thresholds and minimum samples");
  }
  if (proposal.status !== "evaluated" || challenger.status !== "challenger" ||
      champion.id !== input.fromChampionId || proposal.id !== challenger.proposalId) {
    throw new Error("Promotion facts do not match the active Champion and evaluated Proposal");
  }
  return repository.activateChallenger({ ...input, schemaVersion: 1, authority: "human" });
}

export function rollbackChampion(
  repository: EvolutionRepository,
  input: Omit<RollbackDecision, "schemaVersion">,
): ConfigurationVariant {
  if (!input.id.trim() || !input.fromChampionId.trim() || !input.restoreChampionId.trim() ||
      !input.reason.trim() || !input.triggerEvidenceHash.trim() || !input.decidedBy.trim()) {
    throw new Error("Rollback Decision requires reason, trigger Evidence, and actor");
  }
  return repository.rollbackChampion({ ...input, schemaVersion: 1 });
}

function validatePatch(target: EvolutionTarget, patch: Partial<EvolutionConfiguration>): void {
  const allowed: Record<EvolutionTarget, keyof EvolutionConfiguration> = {
    "provider-routing": "providerOrder",
    "role-model-selection": "roleModels",
    "retry-policy": "retryLimit",
    "timeout-policy": "timeoutMs",
    "risk-thresholds": "riskThresholds",
    "memory-retrieval": "memoryRetrievalEnabled",
  };
  const keys = Object.keys(patch) as Array<keyof EvolutionConfiguration>;
  if (keys.length !== 1 || keys[0] !== allowed[target]) throw new Error(`Patch exceeds allowed target ${target}`);
  validateConfiguration({ ...defaultConfiguration(), ...patch });
}

function validateConfiguration(configuration: EvolutionConfiguration): void {
  if (!Array.isArray(configuration.providerOrder) || configuration.providerOrder.length === 0 ||
      configuration.providerOrder.some((provider) => !provider.trim()) ||
      Object.values(configuration.roleModels).some((model) => !model.trim()) ||
      !Number.isSafeInteger(configuration.retryLimit) || configuration.retryLimit < 0 || configuration.retryLimit > 3 ||
      !Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs < 1_000 || configuration.timeoutMs > 600_000 ||
      !Number.isSafeInteger(configuration.riskThresholds.assisted) ||
      !Number.isSafeInteger(configuration.riskThresholds.reviewed) ||
      configuration.riskThresholds.assisted < 0 ||
      configuration.riskThresholds.reviewed <= configuration.riskThresholds.assisted ||
      typeof configuration.memoryRetrievalEnabled !== "boolean") {
    throw new Error("Evolution configuration is outside bounded limits");
  }
}

function defaultConfiguration(): EvolutionConfiguration {
  return {
    providerOrder: ["codex"],
    roleModels: {},
    retryLimit: 1,
    timeoutMs: 60_000,
    riskThresholds: { assisted: 1, reviewed: 2 },
    memoryRetrievalEnabled: false,
  };
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
