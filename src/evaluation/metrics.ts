import type { SanitizedFactBundle } from "./facts.js";

export interface RunMetricsProjection {
  runId: string;
  source: SanitizedFactBundle["source"];
  status: SanitizedFactBundle["run"]["status"];
  readySuccess: boolean;
  doneSuccess: boolean;
  firstPassSuccess: boolean;
  fixPasses: number;
  latencyMs: number;
  agentCalls: number;
  tokens: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
  };
  costUsd: null;
  verificationFailures: number;
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
  reviewRecall: null;
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
  averageLatencyMs: number | null;
  totalAgentCalls: number;
  tokens: RunMetricsProjection["tokens"];
  costUsd: null;
  verificationFailures: number;
  reviewerFindings: RunMetricsProjection["reviewerFindings"];
  reviewPrecision: number | null;
  reviewRecall: null;
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
    latencyMs: duration(facts.run.createdAt, facts.run.updatedAt),
    agentCalls: facts.agentCalls.length,
    tokens: {
      input: nullableSum(facts.agentCalls.map((call) => call.inputTokens)),
      cachedInput: nullableSum(facts.agentCalls.map((call) => call.cachedInputTokens)),
      output: nullableSum(facts.agentCalls.map((call) => call.outputTokens)),
    },
    costUsd: null,
    verificationFailures,
    reviewerFindings,
    reviewPrecision: precision(reviewerFindings.confirmed, reviewerFindings.rejected),
    reviewRecall: null,
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
    reviewRecall: null,
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
