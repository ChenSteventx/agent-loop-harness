import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailTransport } from "../src/email.js";
import { digestWindow, renderMetricsDigest } from "../src/evaluation/digest.js";
import { summarizeMetrics, type RunMetricsProjection } from "../src/evaluation/metrics.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { NotificationDispatcher } from "../src/notifications.js";
import { SqliteStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeEmailTransport implements EmailTransport {
  readonly messages: EmailMessage[] = [];
  failuresRemaining = 0;

  async send(message: EmailMessage) {
    this.messages.push(message);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("fake SMTP unavailable");
    }
    return { providerMessageId: `fake:${message.idempotencyKey}` };
  }
}

describe("Evolution Outbox reliability", () => {
  it("migrates the legacy canary event and installs reliability fields", () => {
    const directory = fixture("evolution-outbox-migration-");
    const path = join(directory, "evaluation.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE evolution_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type = 'canary-rollback'),
        project_scope TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      INSERT INTO evolution_outbox
        (type, project_scope, payload_json, created_at, delivered_at)
      VALUES
        ('canary-rollback', 'generic-node', '{"formalRunId":"run-1"}',
         '2026-07-15T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const store = new EvaluationStore(path);
    expect(store.listPendingEvolutionOutbox()).toEqual([
      expect.objectContaining({
        type: "canary-rolled-back",
        attempts: 0,
        nextAttemptAt: "2026-07-15T00:00:00.000Z",
        deduplicationKey: "evolution:legacy:1",
        deadLetteredAt: null,
        providerMessageId: null,
      }),
    ]);
    const columns = store.database.pragma("table_info(evolution_outbox)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "attempts", "last_error", "next_attempt_at", "deduplication_key", "dead_lettered_at", "provider_message_id",
    ]));
    store.close();
  });

  it("dispatches once, records provider identity, and rejects conflicting idempotency content", async () => {
    const store = new EvaluationStore(join(fixture("evolution-outbox-send-"), "evaluation.sqlite"));
    const first = store.enqueueEvolutionOutbox(
      "proposal-created",
      "generic-node",
      { proposalId: "proposal-1" },
      "2026-07-15T00:00:00.000Z",
      "proposal-created:proposal-1",
    );
    expect(store.enqueueEvolutionOutbox(
      "proposal-created",
      "generic-node",
      { proposalId: "proposal-1" },
      "2026-07-15T00:00:01.000Z",
      "proposal-created:proposal-1",
    ).id).toBe(first.id);
    expect(() => store.enqueueEvolutionOutbox(
      "proposal-created",
      "generic-node",
      { proposalId: "different" },
      "2026-07-15T00:00:02.000Z",
      "proposal-created:proposal-1",
    )).toThrow("different content");

    const transport = new FakeEmailTransport();
    const dispatcher = new NotificationDispatcher(store, transport);
    expect(await dispatcher.dispatch("2026-07-15T00:01:00.000Z"))
      .toEqual({ delivered: 1, retried: 0, deadLettered: 0 });
    expect(await dispatcher.dispatch("2026-07-15T00:02:00.000Z"))
      .toEqual({ delivered: 0, retried: 0, deadLettered: 0 });
    expect(transport.messages).toHaveLength(1);
    expect(store.outboxStatus("2026-07-15T00:02:00.000Z"))
      .toEqual({ pending: 0, dispatchable: 0, delivered: 1, deadLettered: 0 });
    expect(store.database.prepare("SELECT * FROM evolution_outbox WHERE id = ?").get(first.id))
      .toMatchObject({ attempts: 1, provider_message_id: "fake:proposal-created:proposal-1" });
    store.close();
  });

  it("dead-letters bounded failures without changing formal development facts", async () => {
    const directory = fixture("evolution-outbox-isolation-");
    const development = new SqliteStore(join(directory, "state.sqlite"));
    development.createRun("run-1", "task-1", "2026-07-15T00:00:00.000Z");
    development.createOperation({
      id: "operation-1", runId: "run-1", kind: "verification", idempotencyKey: "operation-1",
      now: "2026-07-15T00:00:01.000Z",
    });
    development.finishOperation("operation-1", "succeeded", { exitCode: 0 }, "2026-07-15T00:00:02.000Z");
    development.installEvidence({
      id: "evidence-1", runId: "run-1", operationId: "operation-1", kind: "command",
      commitSha: "abc", policyVersion: "v1", stepId: "test", dependencyHash: "evidence-hash",
      data: { exitCode: 0 }, now: "2026-07-15T00:00:03.000Z",
    });
    development.recordFindingOutcome("run-1", "finding-1", "confirmed", "2026-07-15T00:00:04.000Z");
    const before = formalSnapshot(development);

    const evolution = new EvaluationStore(join(directory, "evaluation.sqlite"));
    evolution.enqueueEvolutionOutbox(
      "shadow-ready", "generic-node", { shadowId: "shadow-1" },
      "2026-07-15T00:01:00.000Z", "shadow-ready:shadow-1",
    );
    const transport = new FakeEmailTransport();
    transport.failuresRemaining = 2;
    const dispatcher = new NotificationDispatcher(evolution, transport, {
      maxAttempts: 2, baseDelayMs: 1_000, maximumDelayMs: 8_000, batchSize: 10,
    });
    expect(await dispatcher.dispatch("2026-07-15T00:01:00.000Z"))
      .toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
    expect(await dispatcher.dispatch("2026-07-15T00:01:01.000Z"))
      .toEqual({ delivered: 0, retried: 0, deadLettered: 1 });
    expect(evolution.listDeadLetterOutbox()).toEqual([
      expect.objectContaining({ attempts: 2, deadLetteredAt: "2026-07-15T00:01:01.000Z" }),
    ]);
    expect(formalSnapshot(development)).toBe(before);
    evolution.close();
    development.close();
  });
});

describe("completed-window Metrics digests", () => {
  it("lets the CLI enqueue once without persisting Fact or Metric projections", () => {
    const directory = fixture("metrics-digest-cli-");
    const development = new SqliteStore(join(directory, "state.sqlite"));
    const todayUtc = Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(),
    );
    development.createRun("digest-run", "task-1", new Date(todayUtc - 1_000).toISOString());
    development.close();
    const argv = [
      resolve("node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "--loop-home", directory,
      "notify", "digest", "--period", "daily",
    ];
    execFileSync(process.execPath, argv, { cwd: resolve("."), stdio: "pipe" });

    const evaluation = new EvaluationStore(join(directory, "evaluation.sqlite"));
    expect(evaluation.listPendingEvolutionOutbox().filter((event) => event.type === "metrics-digest"))
      .toHaveLength(1);
    expect((evaluation.database.prepare("SELECT COUNT(*) AS count FROM fact_bundles").get() as { count: number }).count)
      .toBe(0);
    expect((evaluation.database.prepare("SELECT COUNT(*) AS count FROM metric_projections").get() as { count: number }).count)
      .toBe(0);
    evaluation.close();
  }, 15_000);

  it("uses stable daily and weekly UTC windows and keeps ready distinct from done", () => {
    expect(digestWindow("daily", "2026-07-16T12:34:56.000Z")).toEqual({
      windowStartsAt: "2026-07-15T00:00:00.000Z",
      windowEndsAt: "2026-07-16T00:00:00.000Z",
    });
    expect(digestWindow("weekly", "2026-07-16T23:59:59.000Z")).toEqual({
      windowStartsAt: "2026-07-09T00:00:00.000Z",
      windowEndsAt: "2026-07-16T00:00:00.000Z",
    });
    const metrics = summarizeMetrics([
      projection("real", { readySuccess: true, doneSuccess: false }),
      projection("fixture", { runId: "fixture-run", readySuccess: true, doneSuccess: true }),
    ]);
    const first = renderMetricsDigest("daily", metrics, "2026-07-16T12:34:56.000Z");
    const repeated = renderMetricsDigest("daily", metrics, "2026-07-16T23:59:59.000Z");
    expect(repeated.deduplicationKey).toBe(first.deduplicationKey);
    expect(first.text).toContain("Ready rate (all sources): 100.0%");
    expect(first.text).toContain("Done rate (all sources): 50.0%");
    expect(first.text).toContain("Review recall: unknown");
    expect(first.text).toContain("Cost USD: unknown");
    expect(first.text).toContain("Fixture results are mechanism checks, not production gains.");
  });

  it("sends the rendered digest subject and text through the fake transport", async () => {
    const store = new EvaluationStore(join(fixture("metrics-digest-send-"), "evaluation.sqlite"));
    const digest = renderMetricsDigest(
      "weekly",
      summarizeMetrics([projection("real")]),
      "2026-07-16T12:00:00.000Z",
    );
    store.enqueueEvolutionOutbox(
      "metrics-digest", "all-projects", digest, "2026-07-16T12:00:00.000Z", digest.deduplicationKey,
    );
    const transport = new FakeEmailTransport();
    expect(await new NotificationDispatcher(store, transport).dispatch("2026-07-16T12:00:00.000Z"))
      .toEqual({ delivered: 1, retried: 0, deadLettered: 0 });
    expect(transport.messages).toEqual([
      { idempotencyKey: digest.deduplicationKey, subject: digest.subject, text: digest.text },
    ]);
    store.close();
  });
});

function fixture(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function formalSnapshot(store: SqliteStore): string {
  return JSON.stringify({
    run: store.getRun("run-1"),
    operations: store.listOperations("run-1"),
    events: store.listEvents("run-1"),
    evidence: store.listEvidence("run-1"),
    findings: store.getRunMetrics("run-1"),
  });
}

function projection(
  source: RunMetricsProjection["source"],
  overrides: Partial<RunMetricsProjection> = {},
): RunMetricsProjection {
  return {
    runId: "real-run",
    source,
    status: "ready",
    readySuccess: true,
    doneSuccess: false,
    firstPassSuccess: true,
    fixPasses: 0,
    timeToFirstCandidateMs: null,
    repairRounds: 0,
    latencyMs: 1_000,
    agentCalls: 1,
    tokens: { input: null, cachedInput: null, output: null },
    costUsd: null,
    verificationFailures: 0,
    humanInboxCount: 0,
    humanResolutionDurationMs: null,
    reviewerFindings: {
      total: 0, confirmed: 0, rejected: 0, inconclusive: 0, unresolved: 0,
      byCategory: {}, bySeverity: {},
    },
    reviewPrecision: null,
    reviewRecall: "unknown",
    machineConfirmedFindings: 0,
    machineRejectedFindings: 0,
    inconclusiveFindings: 0,
    humanConfirmedFindings: 0,
    humanRejectedFindings: 0,
    blockedDurationMs: 0,
    postMergeFailureCount: 0,
    providerFallbacks: 0,
    quotaFailures: 0,
    rateLimitFailures: 0,
    resumeRecoveries: 0,
    ...overrides,
  };
}
