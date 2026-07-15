import { operationInputHash } from "../bindings.js";
import type { ChangeProposal, ConfigurationVariant } from "../evolution/proposals.js";
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
  status: "completed" | "insufficient-samples" | "guardrail-failed";
  sampleSize: number;
  champion: VariantAggregate;
  challenger: VariantAggregate;
  deltas: {
    readyRate: number | null;
    doneRate: number | null;
    verificationFailures: number;
    averageLatencyMs: number | null;
  };
  guardrailsSatisfied: boolean;
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
  championAdviceHash: string;
  challengerAdviceHash: string;
  agrees: boolean;
  authoritative: false;
  providerRoutingChanged: false;
  runStateChanged: false;
  createdAt: string;
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
    evaluate: VariantEvaluator;
    createdAt?: string;
  },
): Promise<OfflineComparison> {
  validateComparisonBindings(input);
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
    readyRate: delta(challenger.readyRate, champion.readyRate),
    doneRate: delta(challenger.doneRate, champion.doneRate),
    verificationFailures: challenger.verificationFailures - champion.verificationFailures,
    averageLatencyMs: delta(challenger.averageLatencyMs, champion.averageLatencyMs),
  };
  const guardrails = input.proposal.evaluationPlan.guardrails;
  const guardrailsSatisfied =
    regression(champion.readyRate, challenger.readyRate) <= guardrails.maximumReadyRegression &&
    regression(champion.doneRate, challenger.doneRate) <= guardrails.maximumDoneRegression &&
    deltas.verificationFailures <= guardrails.maximumVerificationFailureIncrease;
  const sampleSize = challenger.samples;
  const status: OfflineComparison["status"] = sampleSize < input.proposal.evaluationPlan.minimumSamples
    ? "insufficient-samples"
    : guardrailsSatisfied ? "completed" : "guardrail-failed";
  const body = {
    projectScope: input.proposal.projectScope,
    proposalId: input.proposal.id,
    championId: input.champion.id,
    challengerId: input.challenger.id,
    datasetIds: input.datasets.map((dataset) => dataset.id).sort(),
    datasetHashes: input.datasets.map((dataset) => dataset.contentHash).sort(),
    holdoutTaskCount: input.datasets.filter((dataset) => dataset.kind === "holdout")
      .reduce((total, dataset) => total + dataset.tasks.length, 0),
    status,
    sampleSize,
    champion,
    challenger,
    deltas,
    guardrailsSatisfied,
    resultHashes: {
      champion: championResults.map((result) => result.resultHash),
      challenger: challengerResults.map((result) => result.resultHash),
    },
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

export async function runShadowEvaluation(
  repository: ComparisonRepository,
  input: {
    id: string;
    facts: SanitizedFactBundle;
    champion: ConfigurationVariant;
    challenger: ConfigurationVariant;
    advise: (variant: ConfigurationVariant, facts: SanitizedFactBundle) => Promise<unknown>;
    createdAt?: string;
  },
): Promise<ShadowEvaluation> {
  if (!input.facts.run.binding || input.champion.projectScope !== input.facts.run.binding.projectAdapterName ||
      input.champion.projectScope !== input.challenger.projectScope || input.champion.status !== "champion" ||
      input.challenger.status !== "challenger") {
    throw new Error("Shadow Evaluation bindings do not match the source Run and variants");
  }
  const championAdviceHash = operationInputHash(await input.advise(input.champion, input.facts));
  const challengerAdviceHash = operationInputHash(await input.advise(input.challenger, input.facts));
  const shadow: ShadowEvaluation = {
    schemaVersion: 1,
    id: requiredText(input.id, "Shadow Evaluation id"),
    sourceRunId: input.facts.run.id,
    sourceFactHash: input.facts.factHash,
    projectScope: input.champion.projectScope,
    championId: input.champion.id,
    challengerId: input.challenger.id,
    championAdviceHash,
    challengerAdviceHash,
    agrees: championAdviceHash === challengerAdviceHash,
    authoritative: false,
    providerRoutingChanged: false,
    runStateChanged: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return repository.installShadowEvaluation(shadow);
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
