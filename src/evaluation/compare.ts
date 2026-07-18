import { operationInputHash } from "../bindings.js";
import type { ChangeProposal, ConfigurationVariant, EvaluationPlan } from "../evolution/proposals.js";
import type { EvaluationDataset, EvaluationTask } from "./datasets.js";
import type { SanitizedFactBundle } from "./facts.js";

export interface TaskEvaluationResult {
  passed: boolean;
  ready: boolean;
  done: boolean;
  verificationFailures: number;
  latencyMs: number;
  resultHash: string;
}

export interface VariantAggregate {
  samples: number;
  passRate: number | null;
  readyRate: number | null;
  doneRate: number | null;
  verificationFailures: number;
  averageLatencyMs: number | null;
}

export interface OfflineComparison {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  proposalId: string;
  championId: string;
  challengerId: string;
  datasetIds: string[];
  datasetHashes: string[];
  holdoutTaskCount: number;
  evaluatorKind: "verify-only" | "full-task-replay";
  evaluatorVersion: string;
  dataSource: "real" | "fixture";
  status: "completed" | "insufficient-samples" | "guardrail-failed";
  sampleSize: number;
  champion: VariantAggregate;
  challenger: VariantAggregate;
  deltas: {
    passRate: number | null;
    readyRate: number | null;
    doneRate: number | null;
    verificationFailures: number;
    averageLatencyMs: number | null;
  };
  primaryMetricResult: {
    metric: EvaluationPlan["primaryMetric"];
    championValue: number | null;
    challengerValue: number | null;
    improvement: number | null;
    minimumImprovement: number;
    passed: boolean;
  };
  guardrailResults: Record<EvaluationPlan["requiredGuardrails"][number], boolean | null>;
  guardrailsSatisfied: boolean;
  promotionEligible: boolean;
  promotionBlockers: string[];
  resultArtifactHash: string;
  resultHash: string;
  createdAt: string;
}

export interface ShadowEvaluation {
  schemaVersion: 1;
  id: string;
  sourceRunId: string;
  sourceFactHash: string;
  projectScope: string;
  championId: string;
  challengerId: string;
  dataSource: "real" | "fixture";
  championAdviceHash: string;
  challengerAdviceHash: string;
  championDecision: ShadowDecision;
  challengerDecision: ShadowDecision;
  differences: ShadowDifference[];
  agrees: boolean;
  authoritative: false;
  providerRoutingChanged: false;
  runStateChanged: false;
  createdAt: string;
}

export interface ShadowDecision {
  contextReferences: string[];
  providerRoute: string;
  executionTemplate: "solo" | "assisted" | "reviewed";
  requireReview: boolean;
  approvedMemoryIds: string[];
  timeoutMs: number;
  retryLimit: number;
}

export interface ShadowDifference {
  field: keyof ShadowDecision;
  champion: ShadowDecision[keyof ShadowDecision];
  challenger: ShadowDecision[keyof ShadowDecision];
}

export interface ComparisonRepository {
  installOfflineComparison(comparison: OfflineComparison): OfflineComparison;
  installShadowEvaluation(shadow: ShadowEvaluation): ShadowEvaluation;
}

export type VariantEvaluator = (
  variant: ConfigurationVariant,
  task: EvaluationTask,
  dataset: EvaluationDataset,
) => Promise<TaskEvaluationResult>;

export async function compareVariants(
  repository: ComparisonRepository,
  input: {
    id: string;
    proposal: ChangeProposal;
    champion: ConfigurationVariant;
    challenger: ConfigurationVariant;
    datasets: readonly EvaluationDataset[];
    evaluatorKind: OfflineComparison["evaluatorKind"];
    evaluatorVersion: string;
    evaluate: VariantEvaluator;
    createdAt?: string;
  },
): Promise<OfflineComparison> {
  validateComparisonBindings(input);
  if (input.evaluatorKind === "verify-only" &&
      ["prompt-variant", "context-ranking", "provider-routing", "role-model-selection", "memory-retrieval"]
        .includes(input.proposal.target)) {
    throw new Error(`Verify-only evaluator cannot evaluate ${input.proposal.target}`);
  }
  if (input.evaluatorKind === "full-task-replay" && input.proposal.evaluationPlan.primaryMetric === "doneRate") {
    // Evaluation runs never merge, so done is unmeasured for both variants;
    // a zero-versus-zero doneRate must not read as evidence.
    throw new Error("Full-task replay cannot measure doneRate as the primary metric");
  }
  const championResults: TaskEvaluationResult[] = [];
  const challengerResults: TaskEvaluationResult[] = [];
  for (const dataset of input.datasets) {
    for (const task of dataset.tasks) {
      championResults.push(await checkedEvaluation(input.evaluate, input.champion, task, dataset));
      challengerResults.push(await checkedEvaluation(input.evaluate, input.challenger, task, dataset));
    }
  }
  const champion = aggregate(championResults);
  const challenger = aggregate(challengerResults);
  const deltas = {
    passRate: delta(challenger.passRate, champion.passRate),
    readyRate: delta(challenger.readyRate, champion.readyRate),
    doneRate: delta(challenger.doneRate, champion.doneRate),
    verificationFailures: challenger.verificationFailures - champion.verificationFailures,
    averageLatencyMs: delta(challenger.averageLatencyMs, champion.averageLatencyMs),
  };
  const guardrails = input.proposal.evaluationPlan.guardrails;
  const guardrailResults: OfflineComparison["guardrailResults"] = {
    ready: regression(champion.readyRate, challenger.readyRate) <= guardrails.maximumReadyRegression,
    done: regression(champion.doneRate, challenger.doneRate) <= guardrails.maximumDoneRegression,
    verificationFailures: deltas.verificationFailures <= guardrails.maximumVerificationFailureIncrease,
    postMergeFailures: null,
    humanEscalation: null,
    latency: null,
    tokens: null,
    cost: null,
  };
  const guardrailsSatisfied = input.proposal.evaluationPlan.requiredGuardrails
    .every((guardrail) => guardrailResults[guardrail] === true);
  const sampleSize = challenger.samples;
  const status: OfflineComparison["status"] = sampleSize < input.proposal.evaluationPlan.minimumSamples
    ? "insufficient-samples"
    : guardrailsSatisfied ? "completed" : "guardrail-failed";
  const primaryMetricResult = comparePrimaryMetric(
    input.proposal.evaluationPlan.primaryMetric,
    input.proposal.evaluationPlan.minimumImprovement,
    champion,
    challenger,
  );
  const dataSource: OfflineComparison["dataSource"] = input.datasets.every((dataset) => dataset.dataSource === "real")
    ? "real"
    : "fixture";
  const datasetBindings = input.datasets
    .map((dataset) => ({ id: dataset.id, hash: dataset.contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const promotionBlockers = [
    sampleSize < input.proposal.evaluationPlan.minimumSamples ? "minimum-samples" : null,
    input.proposal.evaluationPlan.requireHoldout &&
      input.datasets.filter((dataset) => dataset.kind === "holdout").every((dataset) => dataset.tasks.length === 0)
      ? "required-holdout" : null,
    dataSource === "fixture" ? "fixture-data" : null,
    !primaryMetricResult.passed ? "primary-metric" : null,
    !guardrailsSatisfied ? "required-guardrails" : null,
  ].filter((value): value is string => value !== null);
  const resultArtifactHash = operationInputHash({
    evaluatorKind: input.evaluatorKind,
    evaluatorVersion: requiredText(input.evaluatorVersion, "evaluator version"),
    champion: championResults.map((result) => result.resultHash),
    challenger: challengerResults.map((result) => result.resultHash),
  });
  const body = {
    projectScope: input.proposal.projectScope,
    proposalId: input.proposal.id,
    championId: input.champion.id,
    challengerId: input.challenger.id,
    datasetIds: datasetBindings.map((dataset) => dataset.id),
    datasetHashes: datasetBindings.map((dataset) => dataset.hash),
    holdoutTaskCount: input.datasets.filter((dataset) => dataset.kind === "holdout")
      .reduce((total, dataset) => total + dataset.tasks.length, 0),
    evaluatorKind: input.evaluatorKind,
    evaluatorVersion: input.evaluatorVersion,
    dataSource,
    status,
    sampleSize,
    champion,
    challenger,
    deltas,
    primaryMetricResult,
    guardrailResults,
    guardrailsSatisfied,
    promotionEligible: status === "completed" && promotionBlockers.length === 0,
    promotionBlockers,
    resultArtifactHash,
  };
  const comparison: OfflineComparison = {
    schemaVersion: 1,
    id: requiredText(input.id, "Offline Comparison id"),
    ...body,
    resultHash: operationInputHash(body),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return repository.installOfflineComparison(comparison);
}

function comparePrimaryMetric(
  metric: EvaluationPlan["primaryMetric"],
  minimumImprovement: number,
  champion: VariantAggregate,
  challenger: VariantAggregate,
): OfflineComparison["primaryMetricResult"] {
  const championValue = aggregateMetric(champion, metric);
  const challengerValue = aggregateMetric(challenger, metric);
  const improvement = championValue === null || challengerValue === null
    ? null
    : metric === "verificationFailures" || metric === "averageLatencyMs"
      ? championValue - challengerValue
      : challengerValue - championValue;
  return {
    metric,
    championValue,
    challengerValue,
    improvement,
    minimumImprovement,
    passed: improvement !== null && improvement >= minimumImprovement,
  };
}

function aggregateMetric(aggregateValue: VariantAggregate, metric: EvaluationPlan["primaryMetric"]): number | null {
  if (metric === "passRate") return aggregateValue.passRate;
  if (metric === "readyRate") return aggregateValue.readyRate;
  if (metric === "doneRate") return aggregateValue.doneRate;
  if (metric === "verificationFailures") return aggregateValue.verificationFailures;
  return aggregateValue.averageLatencyMs;
}

export async function runShadowEvaluation(
  repository: ComparisonRepository,
  input: {
    id: string;
    facts: SanitizedFactBundle;
    champion: ConfigurationVariant;
    challenger: ConfigurationVariant;
    advise: (variant: ConfigurationVariant, facts: SanitizedFactBundle) => Promise<ShadowDecision>;
    createdAt?: string;
  },
): Promise<ShadowEvaluation> {
  if (!input.facts.run.binding || input.champion.projectScope !== input.facts.run.binding.projectAdapterName ||
      input.champion.projectScope !== input.challenger.projectScope || input.champion.status !== "champion" ||
      input.challenger.status !== "challenger") {
    throw new Error("Shadow Evaluation bindings do not match the source Run and variants");
  }
  const championDecision = validateShadowDecision(await input.advise(input.champion, input.facts));
  const challengerDecision = validateShadowDecision(await input.advise(input.challenger, input.facts));
  const championAdviceHash = operationInputHash(championDecision);
  const challengerAdviceHash = operationInputHash(challengerDecision);
  const differences = shadowDifferences(championDecision, challengerDecision);
  const shadow: ShadowEvaluation = {
    schemaVersion: 1,
    id: requiredText(input.id, "Shadow Evaluation id"),
    sourceRunId: input.facts.run.id,
    sourceFactHash: input.facts.factHash,
    projectScope: input.champion.projectScope,
    championId: input.champion.id,
    challengerId: input.challenger.id,
    dataSource: input.facts.source,
    championAdviceHash,
    challengerAdviceHash,
    championDecision,
    challengerDecision,
    differences,
    agrees: differences.length === 0,
    authoritative: false,
    providerRoutingChanged: false,
    runStateChanged: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return repository.installShadowEvaluation(shadow);
}

function validateShadowDecision(value: ShadowDecision): ShadowDecision {
  if (!Array.isArray(value.contextReferences) || value.contextReferences.some((item) => !item.trim()) ||
      !value.providerRoute.trim() || !["solo", "assisted", "reviewed"].includes(value.executionTemplate) ||
      typeof value.requireReview !== "boolean" || !Array.isArray(value.approvedMemoryIds) ||
      value.approvedMemoryIds.some((item) => !item.trim()) || !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1_000 || !Number.isSafeInteger(value.retryLimit) || value.retryLimit < 0) {
    throw new Error("Shadow evaluator returned an invalid structured decision");
  }
  return {
    ...value,
    contextReferences: [...value.contextReferences],
    approvedMemoryIds: [...value.approvedMemoryIds],
  };
}

function shadowDifferences(champion: ShadowDecision, challenger: ShadowDecision): ShadowDifference[] {
  const fields = Object.keys(champion) as Array<keyof ShadowDecision>;
  return fields.filter((field) => operationInputHash(champion[field]) !== operationInputHash(challenger[field]))
    .map((field) => ({ field, champion: champion[field], challenger: challenger[field] }));
}

function validateComparisonBindings(input: {
  proposal: ChangeProposal;
  champion: ConfigurationVariant;
  challenger: ConfigurationVariant;
  datasets: readonly EvaluationDataset[];
}): void {
  if (input.proposal.status !== "approved" && input.proposal.status !== "evaluated") {
    throw new Error("Offline Comparison requires an approved Proposal");
  }
  if (input.champion.status !== "champion" || input.challenger.status !== "challenger" ||
      input.challenger.proposalId !== input.proposal.id || input.champion.id !== input.proposal.baseChampionId ||
      input.champion.projectScope !== input.proposal.projectScope || input.challenger.projectScope !== input.proposal.projectScope) {
    throw new Error("Offline Comparison variants do not match the Proposal");
  }
  if (input.datasets.length === 0 || input.datasets.some((dataset) =>
    !input.proposal.evaluationPlan.datasetIds.includes(dataset.id) && dataset.kind !== "holdout")) {
    throw new Error("Offline Comparison Dataset is outside the Evaluation Plan");
  }
  // The plan freezes dataset content by hash at proposal time; a same-id
  // dataset with different content must not reach the evaluators.
  for (const dataset of input.datasets) {
    const planned = input.proposal.evaluationPlan.datasetIds.indexOf(dataset.id);
    if (planned >= 0 && input.proposal.evaluationPlan.datasetHashes[planned] !== dataset.contentHash) {
      throw new Error(`Offline Comparison Dataset ${dataset.id} does not match the Evaluation Plan hash`);
    }
  }
}

async function checkedEvaluation(
  evaluate: VariantEvaluator,
  variant: ConfigurationVariant,
  task: EvaluationTask,
  dataset: EvaluationDataset,
): Promise<TaskEvaluationResult> {
  const result = await evaluate(variant, task, dataset);
  if (typeof result.passed !== "boolean" || typeof result.ready !== "boolean" || typeof result.done !== "boolean" ||
      !Number.isSafeInteger(result.verificationFailures) || result.verificationFailures < 0 ||
      !Number.isFinite(result.latencyMs) || result.latencyMs < 0 || !result.resultHash.trim()) {
    throw new Error(`Invalid evaluation result for ${variant.id}/${task.id}`);
  }
  return result;
}

function aggregate(results: readonly TaskEvaluationResult[]): VariantAggregate {
  return {
    samples: results.length,
    passRate: rate(results, (result) => result.passed),
    readyRate: rate(results, (result) => result.ready),
    doneRate: rate(results, (result) => result.done),
    verificationFailures: results.reduce((total, result) => total + result.verificationFailures, 0),
    averageLatencyMs: results.length === 0
      ? null
      : results.reduce((total, result) => total + result.latencyMs, 0) / results.length,
  };
}

function rate(values: readonly TaskEvaluationResult[], predicate: (value: TaskEvaluationResult) => boolean): number | null {
  return values.length === 0 ? null : values.filter(predicate).length / values.length;
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function regression(champion: number | null, challenger: number | null): number {
  return champion === null || challenger === null ? Number.POSITIVE_INFINITY : champion - challenger;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
