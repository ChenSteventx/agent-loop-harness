import type { MetricsSummary } from "./metrics.js";

export type DigestPeriod = "daily" | "weekly";

export interface MetricsDigest {
  period: DigestPeriod;
  windowStartsAt: string;
  windowEndsAt: string;
  deduplicationKey: string;
  subject: string;
  text: string;
  metrics: MetricsSummary;
  activityInWindow: number;
  completedOutcomesInWindow: { ready: number; done: number };
}

export interface DigestEvent {
  runId: string;
  type: string;
  createdAt: string;
}

export function renderMetricsDigest(
  period: DigestPeriod,
  metrics: MetricsSummary,
  now = new Date().toISOString(),
  eventCounts: { activity: number; ready: number; done: number } = {
    activity: metrics.runCount, ready: 0, done: 0,
  },
): MetricsDigest {
  const window = digestWindow(period, now);
  const label = period === "daily" ? "Daily" : "Weekly";
  return {
    period,
    ...window,
    deduplicationKey: `metrics-digest:${period}:${window.windowStartsAt}`,
    subject: `[agent-loop] ${label} metrics digest ${window.windowStartsAt.slice(0, 10)}`,
    text: [
      `${label} Agent Loop metrics`,
      `Window: ${window.windowStartsAt} .. ${window.windowEndsAt}`,
      `Activity in window: ${eventCounts.activity} runs`,
      `Completed outcomes in window: ready=${eventCounts.ready}, done=${eventCounts.done}`,
      `Activity metrics: ${metrics.runCount} runs (real=${metrics.realRunCount}, fixture=${metrics.fixtureRunCount})`,
      `Ready rate (all sources): ${formatRate(metrics.readySuccessRate)}`,
      `Done rate (all sources): ${formatRate(metrics.doneSuccessRate)}`,
      `First-pass rate: ${formatRate(metrics.firstPassSuccessRate)}`,
      `Verification failures: ${metrics.verificationFailures}`,
      `Provider fallbacks: ${metrics.providerFallbacks}`,
      `Human inbox items: ${metrics.humanInboxCount}`,
      `Confirmed findings: ${metrics.reviewerFindings.confirmed}`,
      `Rejected findings: ${metrics.reviewerFindings.rejected}`,
      `Inconclusive findings: ${metrics.inconclusiveFindings}`,
      `Review recall: ${metrics.reviewRecall}`,
      `Tokens: input=${formatNullable(metrics.tokens.input)}, cached=${formatNullable(metrics.tokens.cachedInput)}, output=${formatNullable(metrics.tokens.output)}`,
      "Cost USD: unknown",
      "Fixture results are mechanism checks, not production gains.",
    ].join("\n"),
    metrics,
    activityInWindow: eventCounts.activity,
    completedOutcomesInWindow: { ready: eventCounts.ready, done: eventCounts.done },
  };
}

export function digestEventCounts(events: readonly DigestEvent[], window: {
  windowStartsAt: string; windowEndsAt: string;
}): { runIds: string[]; activity: number; ready: number; done: number } {
  const selected = events.filter((event) =>
    event.createdAt >= window.windowStartsAt && event.createdAt < window.windowEndsAt);
  const runIds = [...new Set(selected.map((event) => event.runId))].sort();
  return {
    runIds,
    activity: runIds.length,
    ready: new Set(selected.filter((event) => event.type === "run.ready").map((event) => event.runId)).size,
    done: new Set(selected.filter((event) => event.type === "run.done").map((event) => event.runId)).size,
  };
}

export function digestWindow(period: DigestPeriod, now: string): {
  windowStartsAt: string;
  windowEndsAt: string;
} {
  const parsed = new Date(now);
  if (Number.isNaN(parsed.getTime())) throw new Error("Digest timestamp is invalid");
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const days = period === "daily" ? 1 : period === "weekly" ? 7 : invalidPeriod(period);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1_000);
  return { windowStartsAt: start.toISOString(), windowEndsAt: end.toISOString() };
}

function invalidPeriod(value: never): never {
  throw new Error(`Unknown digest period: ${String(value)}`);
}

function formatRate(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
}

function formatNullable(value: number | null): string {
  return value === null ? "unknown" : String(value);
}
