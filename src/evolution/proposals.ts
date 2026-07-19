import { operationInputHash } from "../bindings.js";
import type { OfflineComparison } from "../evaluation/compare.js";
import type { EvaluationDataset } from "../evaluation/datasets.js";
import { agentRoles, authorPromptVariants } from "../roles.js";
import type { Risk } from "../routing.js";

export const evolutionTargets = [
  "prompt-variant",
  "context-ranking",
  "provider-routing",
  "role-model-selection",
  "retry-policy",
  "timeout-policy",
  "low-risk-review-rubric",
  "memory-retrieval",
] as const;
export type EvolutionTarget = (typeof evolutionTargets)[number];

// The only targets whose configuration genuinely changes formal execution
// today. Proposals for the other vocabulary entries are rejected until their
// runtime wiring exists — otherwise a Challenger could be promoted on a
// configuration that never takes effect, an empty evolution.
export const runtimeWiredTargets: readonly EvolutionTarget[] = [
  "prompt-variant",
  "provider-routing",
  "role-model-selection",
  "retry-policy",
  "timeout-policy",
  "low-risk-review-rubric",
];

export interface EvolutionConfiguration {
  promptVariant?: string;
  contextRanking?: string[];
  providerOrder: string[];
  roleModels: Record<string, string>;
  retryLimit: number;
  timeoutMs: number;
  riskThresholds: { assisted: number; reviewed: number };
  lowRiskReviewRubric?: string;
  memoryRetrievalEnabled: boolean;
}

export interface EvaluationPlan {
  datasetIds: string[];
  datasetHashes: string[];
  metrics: string[];
  minimumSamples: number;
  primaryMetric: "passRate" | "readyRate" | "doneRate" | "verificationFailures" | "averageLatencyMs";
  minimumImprovement: number;
  requiredGuardrails: Array<"ready" | "done" | "verificationFailures" | "postMergeFailures" |
    "humanEscalation" | "latency" | "tokens" | "cost">;
  requireHoldout: boolean;
  risk: Risk;
  rollbackCondition: string;
  approvalRequired: boolean;
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
  getOfflineComparison(id: string): OfflineComparison | null;
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
  primaryMetric?: EvaluationPlan["primaryMetric"];
  minimumImprovement?: number;
  requiredGuardrails?: EvaluationPlan["requiredGuardrails"];
  requireHoldout?: boolean;
  risk?: Risk;
  rollbackCondition?: string;
  approvalRequired?: boolean;
  createdAt?: string;
}): ChangeProposal {
  if (!evolutionTargets.includes(input.target)) throw new Error(`Forbidden evolution target: ${String(input.target)}`);
  if (!runtimeWiredTargets.includes(input.target)) {
    throw new Error(`unsupported-runtime-target: ${input.target} is not wired into the formal runtime, ` +
      "so evolving it would promote a configuration that never takes effect");
  }
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
  const datasetBindings = input.datasets
    .map((dataset) => ({ id: dataset.id, hash: dataset.contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const evaluationPlan: EvaluationPlan = {
    datasetIds: datasetBindings.map((dataset) => dataset.id),
    datasetHashes: datasetBindings.map((dataset) => dataset.hash),
    metrics: [...new Set(input.metrics)].sort(),
    minimumSamples: input.minimumSamples,
    primaryMetric: input.primaryMetric ?? "readyRate",
    minimumImprovement: input.minimumImprovement ?? 0.01,
    requiredGuardrails: input.requiredGuardrails ?? ["ready", "done", "verificationFailures"],
    requireHoldout: input.requireHoldout ?? true,
    risk: input.risk ?? "normal",
    rollbackCondition: requiredText(
      input.rollbackCondition ?? "rollback on any required guardrail violation",
      "rollback condition",
    ),
    approvalRequired: input.approvalRequired ?? true,
    guardrails: {
      maximumReadyRegression: 0,
      maximumDoneRegression: 0,
      maximumVerificationFailureIncrease: 0,
    },
  };
  if (evaluationPlan.datasetIds.length === 0 || evaluationPlan.metrics.length === 0) {
    throw new Error("Evaluation Plan requires datasets and metrics");
  }
  if (!Number.isFinite(evaluationPlan.minimumImprovement) || evaluationPlan.minimumImprovement < 0 ||
      evaluationPlan.requiredGuardrails.length === 0) {
    throw new Error("Evaluation Plan requires a non-negative improvement and guardrails");
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
  input: {
    id: string;
    comparisonId: string;
    decidedBy: string;
    reason: string;
    decidedAt?: string;
  },
): ConfigurationVariant {
  requiredText(input.id, "Promotion Decision id");
  requiredText(input.comparisonId, "offline comparison id");
  requiredText(input.decidedBy, "human decision maker");
  requiredText(input.reason, "promotion reason");
  const comparison = repository.getOfflineComparison(input.comparisonId);
  if (!comparison) throw new Error("Offline Comparison not found");
  const proposal = repository.getChangeProposal(comparison.proposalId);
  const challenger = repository.getConfigurationVariant(comparison.challengerId);
  const champion = repository.activeChampion(comparison.projectScope);
  if (!proposal || !challenger || !champion) throw new Error("Promotion facts are incomplete");
  if (proposal.status !== "evaluated" || challenger.status !== "challenger" ||
      champion.id !== comparison.championId || proposal.id !== challenger.proposalId ||
      proposal.id !== comparison.proposalId || challenger.id !== comparison.challengerId) {
    throw new Error("Promotion facts do not match the active Champion and evaluated Proposal");
  }
  const plannedDatasets = proposal.evaluationPlan.datasetIds.map((id, index) =>
    `${id}\0${proposal.evaluationPlan.datasetHashes[index] ?? ""}`);
  const comparedDatasets = new Set(comparison.datasetIds.map((id, index) =>
    `${id}\0${comparison.datasetHashes[index] ?? ""}`));
  const guardrailsPassed = proposal.evaluationPlan.requiredGuardrails.every((guardrail) =>
    comparison.guardrailResults[guardrail] === true);
  if (comparison.status !== "completed" || comparison.sampleSize < proposal.evaluationPlan.minimumSamples ||
      (proposal.evaluationPlan.requireHoldout && comparison.holdoutTaskCount <= 0) ||
      comparison.dataSource === "fixture" || !comparison.primaryMetricResult.passed ||
      comparison.primaryMetricResult.metric !== proposal.evaluationPlan.primaryMetric ||
      comparison.primaryMetricResult.minimumImprovement !== proposal.evaluationPlan.minimumImprovement ||
      !guardrailsPassed || !comparison.promotionEligible || comparison.promotionBlockers.length > 0 ||
      plannedDatasets.some((binding) => !comparedDatasets.has(binding)) ||
      (proposal.evaluationPlan.approvalRequired && proposal.approval?.authority !== "human")) {
    throw new Error("Offline Comparison is not eligible for promotion");
  }
  const decidedAt = input.decidedAt ?? new Date().toISOString();
  return repository.activateChallenger({
    schemaVersion: 1,
    id: input.id,
    projectScope: comparison.projectScope,
    proposalId: comparison.proposalId,
    fromChampionId: comparison.championId,
    challengerId: comparison.challengerId,
    verdict: "promote",
    comparisonId: comparison.id,
    authority: "human",
    decidedBy: input.decidedBy,
    reason: input.reason,
    decidedAt,
  });
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
    "prompt-variant": "promptVariant",
    "context-ranking": "contextRanking",
    "provider-routing": "providerOrder",
    "role-model-selection": "roleModels",
    "retry-policy": "retryLimit",
    "timeout-policy": "timeoutMs",
    "low-risk-review-rubric": "lowRiskReviewRubric",
    "memory-retrieval": "memoryRetrievalEnabled",
  };
  const keys = Object.keys(patch) as Array<keyof EvolutionConfiguration>;
  if (keys.length !== 1 || keys[0] !== allowed[target]) throw new Error(`Patch exceeds allowed target ${target}`);
  validateConfiguration({ ...defaultConfiguration(), ...patch });
}

function validateConfiguration(configuration: EvolutionConfiguration): void {
  if (configuration.promptVariant !== undefined &&
      !authorPromptVariants.includes(configuration.promptVariant)) {
    throw new Error(`Author prompt variant is not registered: ${configuration.promptVariant}`);
  }
  for (const [role, model] of Object.entries(configuration.roleModels)) {
    if (!(agentRoles as readonly string[]).includes(role)) {
      throw new Error(`Role model selection names an unknown role: ${role}`);
    }
    if (!model.trim() || model.length > 128) {
      throw new Error(`Role model for ${role} must be non-empty and at most 128 characters`);
    }
  }
  if (configuration.lowRiskReviewRubric !== undefined && configuration.lowRiskReviewRubric.length > 500) {
    throw new Error("Low-risk review rubric must be at most 500 characters");
  }
  if ((configuration.promptVariant !== undefined && !configuration.promptVariant.trim()) ||
      (configuration.contextRanking !== undefined &&
        (!Array.isArray(configuration.contextRanking) || configuration.contextRanking.length === 0 ||
          configuration.contextRanking.some((value) => !value.trim()))) ||
      (configuration.lowRiskReviewRubric !== undefined && !configuration.lowRiskReviewRubric.trim()) ||
      !Array.isArray(configuration.providerOrder) || configuration.providerOrder.length === 0 ||
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
    promptVariant: "baseline",
    contextRanking: ["task", "acceptance", "repository"],
    providerOrder: ["codex"],
    roleModels: {},
    retryLimit: 1,
    timeoutMs: 60_000,
    riskThresholds: { assisted: 1, reviewed: 2 },
    lowRiskReviewRubric: "verify acceptance and regression evidence",
    memoryRetrievalEnabled: false,
  };
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
