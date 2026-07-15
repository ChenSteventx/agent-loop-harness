import type { SanitizedFactBundle } from "./facts.js";

export interface RunMetricsProjection {
  runId: string;
  source: SanitizedFactBundle["source"];
  status: SanitizedFactBundle["run"]["status"];
  readySuccess: boolean;
  doneSuccess: boolean;
  firstPassSuccess: boolean;
  fixPasses: number;
  timeToFirstCandidateMs: number | null;
  repairRounds: number;
  latencyMs: number;
  agentCalls: number;
  tokens: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
  };
  costUsd: null;
  verificationFailures: number;
  humanInboxCount: number;
  humanResolutionDurationMs: number | null;
  reviewerFindings: {
    total: number;
    confirmed: number;
    rejected: number;
    inconclusive: number;
    unresolved: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  reviewPrecision: number | null;
  reviewRecall: "unknown";
  machineConfirmedFindings: number;
  machineRejectedFindings: number;
  inconclusiveFindings: number;
  humanConfirmedFindings: number;
  humanRejectedFindings: number;
  blockedDurationMs: number;
  postMergeFailureCount: number;
  providerFallbacks: number;
  quotaFailures: number;
  rateLimitFailures: number;
  resumeRecoveries: number;
}

export interface MetricsSummary {
  runCount: number;
  realRunCount: number;
  fixtureRunCount: number;
  readySuccessRate: number | null;
  doneSuccessRate: number | null;
  firstPassSuccessRate: number | null;
  averageFixPasses: number | null;
  averageTimeToFirstCandidateMs: number | null;
  averageLatencyMs: number | null;
  totalAgentCalls: number;
  tokens: RunMetricsProjection["tokens"];
  costUsd: null;
  verificationFailures: number;
  reviewerFindings: RunMetricsProjection["reviewerFindings"];
  reviewPrecision: number | null;
  reviewRecall: "unknown";
  machineConfirmedFindings: number;
  machineRejectedFindings: number;
  inconclusiveFindings: number;
  humanConfirmedFindings: number;
  humanRejectedFindings: number;
  humanInboxCount: number;
  averageHumanResolutionDurationMs: number | null;
  blockedDurationMs: number;
  postMergeFailureCount: number;
  providerFallbacks: number;
  quotaFailures: number;
  rateLimitFailures: number;
  resumeRecoveries: number;
}

export function projectRunMetrics(facts: SanitizedFactBundle): RunMetricsProjection {
  const readySuccess = facts.run.status === "ready" || facts.run.status === "merged" || facts.run.status === "done" ||
    facts.events.some((event) => event.type === "run.ready");
  const doneSuccess = facts.run.status === "done" || facts.events.some((event) => event.type === "run.done");
  const fixPasses = facts.operations.filter((operation) => operation.kind === "repair" && operation.status === "succeeded").length;
  const verificationFailures = facts.evidence.filter((item) => item.kind === "verification_failure").length +
    facts.operations.filter((operation) => operation.kind === "verification" && operation.status === "failed").length;
  const reviewerFindings = findingSummary(facts);
  return {
    runId: facts.run.id,
    source: facts.source,
    status: facts.run.status,
    readySuccess,
    doneSuccess,
    firstPassSuccess: readySuccess && fixPasses === 0 && verificationFailures === 0,
    fixPasses,
    timeToFirstCandidateMs: timeToFirstCandidate(facts),
    repairRounds: fixPasses,
    latencyMs: duration(facts.run.createdAt, facts.run.updatedAt),
    agentCalls: facts.agentCalls.length,
    tokens: {
      input: nullableSum(facts.agentCalls.map((call) => call.inputTokens)),
      cachedInput: nullableSum(facts.agentCalls.map((call) => call.cachedInputTokens)),
      output: nullableSum(facts.agentCalls.map((call) => call.outputTokens)),
    },
    costUsd: null,
    verificationFailures,
    humanInboxCount: facts.human.length,
    humanResolutionDurationMs: humanResolutionDuration(facts),
    reviewerFindings,
    reviewPrecision: precision(reviewerFindings.confirmed, reviewerFindings.rejected),
    reviewRecall: "unknown",
    machineConfirmedFindings: facts.reviewerFindings.filter((finding) => finding.authority === "machine" && finding.outcome === "confirmed").length,
    machineRejectedFindings: facts.reviewerFindings.filter((finding) => finding.authority === "machine" && finding.outcome === "rejected").length,
    inconclusiveFindings: facts.reviewerFindings.filter((finding) => finding.outcome === "inconclusive" || finding.outcome === "unresolved").length,
    humanConfirmedFindings: facts.reviewerFindings.filter((finding) => finding.authority === "human" && finding.outcome === "confirmed").length,
    humanRejectedFindings: facts.reviewerFindings.filter((finding) => finding.authority === "human" && finding.outcome === "rejected").length,
    blockedDurationMs: blockedDuration(facts),
    postMergeFailureCount: facts.operations.filter((operation) => operation.kind.includes("post-merge") && operation.status === "failed").length,
    providerFallbacks: countEvents(facts, "provider.fallback"),
    quotaFailures: facts.events.filter((event) => event.type === "provider.failure" && event.failureClass === "quota").length,
    rateLimitFailures: facts.events.filter((event) => event.type === "provider.failure" && event.failureClass === "rate_limit").length,
    resumeRecoveries: facts.events.filter((event) => event.type === "run.resumed" || event.type.endsWith(".recovered")).length,
  };
}

export function summarizeMetrics(values: readonly RunMetricsProjection[]): MetricsSummary {
  const findings = values.reduce((aggregate, value) => mergeFindingSummary(aggregate, value.reviewerFindings), emptyFindings());
  return {
    runCount: values.length,
    realRunCount: values.filter((value) => value.source === "real").length,
    fixtureRunCount: values.filter((value) => value.source === "fixture").length,
    readySuccessRate: rate(values, (value) => value.readySuccess),
    doneSuccessRate: rate(values, (value) => value.doneSuccess),
    firstPassSuccessRate: rate(values, (value) => value.firstPassSuccess),
    averageFixPasses: average(values.map((value) => value.fixPasses)),
    averageTimeToFirstCandidateMs: averageNullable(values.map((value) => value.timeToFirstCandidateMs)),
    averageLatencyMs: average(values.map((value) => value.latencyMs)),
    totalAgentCalls: sum(values.map((value) => value.agentCalls)),
    tokens: {
      input: nullableSum(values.map((value) => value.tokens.input)),
      cachedInput: nullableSum(values.map((value) => value.tokens.cachedInput)),
      output: nullableSum(values.map((value) => value.tokens.output)),
    },
    costUsd: null,
    verificationFailures: sum(values.map((value) => value.verificationFailures)),
    reviewerFindings: findings,
    reviewPrecision: precision(findings.confirmed, findings.rejected),
    reviewRecall: "unknown",
    machineConfirmedFindings: sum(values.map((value) => value.machineConfirmedFindings)),
    machineRejectedFindings: sum(values.map((value) => value.machineRejectedFindings)),
    inconclusiveFindings: sum(values.map((value) => value.inconclusiveFindings)),
    humanConfirmedFindings: sum(values.map((value) => value.humanConfirmedFindings)),
    humanRejectedFindings: sum(values.map((value) => value.humanRejectedFindings)),
    humanInboxCount: sum(values.map((value) => value.humanInboxCount)),
    averageHumanResolutionDurationMs: averageNullable(values.map((value) => value.humanResolutionDurationMs)),
    blockedDurationMs: sum(values.map((value) => value.blockedDurationMs)),
    postMergeFailureCount: sum(values.map((value) => value.postMergeFailureCount)),
    providerFallbacks: sum(values.map((value) => value.providerFallbacks)),
    quotaFailures: sum(values.map((value) => value.quotaFailures)),
    rateLimitFailures: sum(values.map((value) => value.rateLimitFailures)),
    resumeRecoveries: sum(values.map((value) => value.resumeRecoveries)),
  };
}

function findingSummary(facts: SanitizedFactBundle): RunMetricsProjection["reviewerFindings"] {
  const summary = emptyFindings();
  for (const finding of facts.reviewerFindings) {
    summary.total += 1;
    summary[finding.outcome] += 1;
    summary.byCategory[finding.category] = (summary.byCategory[finding.category] ?? 0) + 1;
    summary.bySeverity[finding.severity] = (summary.bySeverity[finding.severity] ?? 0) + 1;
  }
  return summary;
}

function emptyFindings(): RunMetricsProjection["reviewerFindings"] {
  return { total: 0, confirmed: 0, rejected: 0, inconclusive: 0, unresolved: 0, byCategory: {}, bySeverity: {} };
}

function mergeFindingSummary(
  left: RunMetricsProjection["reviewerFindings"],
  right: RunMetricsProjection["reviewerFindings"],
): RunMetricsProjection["reviewerFindings"] {
  return {
    total: left.total + right.total,
    confirmed: left.confirmed + right.confirmed,
    rejected: left.rejected + right.rejected,
    inconclusive: left.inconclusive + right.inconclusive,
    unresolved: left.unresolved + right.unresolved,
    byCategory: mergeCounts(left.byCategory, right.byCategory),
    bySeverity: mergeCounts(left.bySeverity, right.bySeverity),
  };
}

function mergeCounts(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) result[key] = (result[key] ?? 0) + value;
  return result;
}

function countEvents(facts: SanitizedFactBundle, type: string): number {
  return facts.events.filter((event) => event.type === type).length;
}

function duration(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableSum(values: readonly (number | null)[]): number | null {
  return values.length > 0 && values.every((value) => value !== null)
    ? sum(values as number[])
    : null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function rate<T>(values: readonly T[], predicate: (value: T) => boolean): number | null {
  return values.length === 0 ? null : values.filter(predicate).length / values.length;
}

function precision(confirmed: number, rejected: number): number | null {
  const denominator = confirmed + rejected;
  return denominator === 0 ? null : confirmed / denominator;
}

function timeToFirstCandidate(facts: SanitizedFactBundle): number | null {
  const candidate = facts.evidence.find((item) => item.kind === "candidate_commit");
  return candidate ? duration(facts.run.createdAt, candidate.createdAt) : null;
}

function humanResolutionDuration(facts: SanitizedFactBundle): number | null {
  const durations = facts.human
    .filter((item) => item.resolvedAt !== null)
    .map((item) => duration(item.createdAt, item.resolvedAt!));
  return durations.length === 0 ? null : sum(durations);
}

function blockedDuration(facts: SanitizedFactBundle): number {
  let blockedAt: string | null = null;
  let total = 0;
  for (const event of facts.events) {
    if (event.type === "run.blocked") blockedAt = event.createdAt;
    if (event.type === "run.resumed" && blockedAt) {
      total += duration(blockedAt, event.createdAt);
      blockedAt = null;
    }
  }
  if (blockedAt) total += duration(blockedAt, facts.run.updatedAt);
  return total;
}

function averageNullable(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return average(known);
}
