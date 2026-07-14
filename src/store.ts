import Database from "better-sqlite3";
import {
  createRun as newRun,
  resumeBlockedRun,
  reopenReadyRun,
  transitionRun,
  type Event,
  type Evidence,
  type Operation,
  type Run,
  type RunStatus,
  type TransitionOptions,
} from "./domain.js";

type Sqlite = InstanceType<typeof Database>;

export const outboxEventTypes = ["blocked", "needs-human", "provider-fallback", "ready", "done"] as const;
export type OutboxEventType = (typeof outboxEventTypes)[number];

export interface OutboxRecord {
  id: number; runId: string; type: OutboxEventType; payload: unknown; createdAt: string;
  deliveredAt: string | null; attempts: number; lastError: string | null;
}

export interface HumanInboxInput {
  question: string;
  options: readonly string[];
  recommendation: string;
  evidence: unknown;
  risk: string;
  consequence: string;
  resumeCommand: string;
}

export interface HumanInboxRecord extends HumanInboxInput {
  id: number; runId: string; createdAt: string; resolvedAt: string | null;
}

export interface RunMetrics {
  agentCalls: number;
  latencyMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  confirmedFindings: number;
  falsePositives: number;
}

export class SqliteStore {
  readonly database: Sqlite;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createRun(id: string, taskId: string, now = new Date().toISOString()): Run {
    const run = newRun(id, taskId, now);
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO runs
           (id, task_id, status, blocked_json, merge_sha, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(run.id, run.taskId, run.status, null, null, run.createdAt, run.updatedAt);
      this.insertEvent(run.id, "run.created", { taskId }, now);
    });
    try {
      transaction();
    } catch (error) {
      throw contextualize(error, `Cannot create run ${id}`);
    }
    return run;
  }

  getRun(id: string): Run | null {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(): Run[] {
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at, id").all() as RunRow[];
    return rows.map(mapRun);
  }

  transitionRun(
    id: string,
    target: RunStatus,
    options: TransitionOptions = {},
    eventData: unknown = {},
  ): Run {
    const transaction = this.database.transaction(() => {
      const current = this.requireRun(id);
      const updated = transitionRun(current, target, options);
      this.writeRun(updated);
      this.insertEvent(id, `run.${target}`, eventData, updated.updatedAt);
      if (target === "blocked" || target === "ready" || target === "done") {
        this.insertOutbox(id, target, eventData, updated.updatedAt);
      }
      return updated;
    });
    try {
      return transaction();
    } catch (error) {
      throw contextualize(error, `Cannot transition run ${id} to ${target}`);
    }
  }

  resumeRun(id: string, now = new Date().toISOString()): Run {
    const transaction = this.database.transaction(() => {
      const updated = resumeBlockedRun(this.requireRun(id), now);
      this.writeRun(updated);
      this.insertEvent(id, "run.resumed", {}, now);
      return updated;
    });
    return transaction();
  }

  reopenRunForInvalidEvidence(id: string, now = new Date().toISOString()): Run {
    const transaction = this.database.transaction(() => {
      const updated = reopenReadyRun(this.requireRun(id), now);
      this.writeRun(updated);
      this.insertEvent(id, "run.reopened", { reason: "evidence invalidated" }, now);
      return updated;
    });
    return transaction();
  }

  appendEvent(runId: string, type: string, data: unknown, now = new Date().toISOString()): Event {
    this.requireRun(runId);
    const id = this.insertEvent(runId, type, data, now);
    return { id, runId, type, data, createdAt: now };
  }

  listEvents(runId: string): Event[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id")
      .all(runId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      data: parseJson(row.data_json),
      createdAt: row.created_at,
    }));
  }

  createOperation(input: {
    id: string;
    runId: string;
    kind: string;
    idempotencyKey: string;
    now?: string;
  }): Operation {
    const existing = this.operationByKey(input.idempotencyKey);
    if (existing) {
      if (existing.runId !== input.runId || existing.kind !== input.kind) {
        throw new Error(`Idempotency key ${input.idempotencyKey} belongs to another operation`);
      }
      return existing;
    }
    this.requireRun(input.runId);
    const startedAt = input.now ?? new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO operations
           (id, run_id, kind, idempotency_key, status, result_json, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)`,
        )
        .run(input.id, input.runId, input.kind, input.idempotencyKey, startedAt);
    } catch (error) {
      throw contextualize(error, `Cannot create operation ${input.id}`);
    }
    return this.requireOperation(input.id);
  }

  getOperation(id: string): Operation | null {
    const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
      | OperationRow
      | undefined;
    return row ? mapOperation(row) : null;
  }

  listOperations(runId: string): Operation[] {
    const rows = this.database
      .prepare("SELECT * FROM operations WHERE run_id = ? ORDER BY started_at, id")
      .all(runId) as OperationRow[];
    return rows.map(mapOperation);
  }

  finishOperation(
    id: string,
    status: "succeeded" | "failed",
    result: unknown,
    now = new Date().toISOString(),
  ): Operation {
    const current = this.requireOperation(id);
    if (current.status !== "running") {
      if (current.status === status && JSON.stringify(current.result) === JSON.stringify(result)) return current;
      throw new Error(`Operation ${id} is already ${current.status}`);
    }
    const serialized = JSON.stringify(result);
    this.database
      .prepare("UPDATE operations SET status = ?, result_json = ?, finished_at = ? WHERE id = ?")
      .run(status, serialized, now, id);
    return this.requireOperation(id);
  }

  installEvidence(input: Omit<Evidence, "status" | "createdAt" | "invalidatedAt"> & { now?: string }): Evidence {
    const existing = this.database
      .prepare("SELECT * FROM evidence WHERE run_id = ? AND kind = ? AND dependency_hash = ?")
      .get(input.runId, input.kind, input.dependencyHash) as EvidenceRow | undefined;
    if (existing) return mapEvidence(existing);
    this.requireRun(input.runId);
    const now = input.now ?? new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO evidence
         (id, run_id, operation_id, kind, status, commit_sha, policy_version, step_id,
          dependency_hash, data_json, created_at, invalidated_at)
         VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.runId,
        input.operationId,
        input.kind,
        input.commitSha,
        input.policyVersion,
        input.stepId,
        input.dependencyHash,
        JSON.stringify(input.data),
        now,
      );
    return this.requireEvidence(input.id);
  }

  listEvidence(runId: string, status?: "valid" | "invalid"): Evidence[] {
    const rows = status
      ? (this.database
          .prepare("SELECT * FROM evidence WHERE run_id = ? AND status = ? ORDER BY created_at, id")
          .all(runId, status) as EvidenceRow[])
      : (this.database
          .prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at, id")
          .all(runId) as EvidenceRow[]);
    return rows.map(mapEvidence);
  }

  invalidateEvidenceExcept(
    runId: string,
    validDependencyHashes: readonly string[],
    now = new Date().toISOString(),
  ): number {
    if (validDependencyHashes.length === 0) {
      return this.database
        .prepare("UPDATE evidence SET status = 'invalid', invalidated_at = ? WHERE run_id = ? AND status = 'valid'")
        .run(now, runId).changes;
    }
    const placeholders = validDependencyHashes.map(() => "?").join(", ");
    return this.database
      .prepare(
        `UPDATE evidence SET status = 'invalid', invalidated_at = ?
         WHERE run_id = ? AND status = 'valid' AND dependency_hash NOT IN (${placeholders})`,
      )
      .run(now, runId, ...validDependencyHashes).changes;
  }

  enqueueOutbox(runId: string, type: OutboxEventType, payload: unknown, now = new Date().toISOString()): OutboxRecord {
    this.requireRun(runId);
    const transaction = this.database.transaction(() => this.requireOutbox(this.insertOutbox(runId, type, payload, now)));
    return transaction();
  }

  createHumanInbox(runId: string, input: HumanInboxInput, now = new Date().toISOString()): HumanInboxRecord {
    this.requireRun(runId);
    validateHumanInbox(input);
    const transaction = this.database.transaction(() => {
      const result = this.database.prepare(
        `INSERT INTO human_inbox
         (run_id, question, options_json, recommendation, evidence_json, risk, consequence, resume_command, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(runId, input.question, JSON.stringify(input.options), input.recommendation,
        JSON.stringify(input.evidence), input.risk, input.consequence, input.resumeCommand, now);
      this.insertOutbox(runId, "needs-human", input, now);
      return this.requireHumanInbox(Number(result.lastInsertRowid));
    });
    return transaction();
  }

  listHumanInbox(runId: string): HumanInboxRecord[] {
    return (this.database.prepare("SELECT * FROM human_inbox WHERE run_id = ? ORDER BY id").all(runId) as HumanInboxRow[]).map(mapHumanInbox);
  }

  listPendingOutbox(): OutboxRecord[] {
    return (this.database.prepare("SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY id").all() as OutboxRow[]).map(mapOutbox);
  }

  markOutboxDelivered(id: number, now = new Date().toISOString()): void {
    this.database.prepare("UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?").run(now, id);
  }

  markOutboxFailed(id: number, error: string): void {
    this.database.prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(error, id);
  }

  recordAgentCall(runId: string, input: {
    role: string; provider: string; latencyMs: number;
    usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
  }, now = new Date().toISOString()): void {
    this.requireRun(runId);
    if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) throw new Error("Agent call latency must be non-negative");
    this.database.prepare(
      `INSERT INTO agent_call_metrics
       (run_id, role, provider, latency_ms, input_tokens, cached_input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, input.role, input.provider, input.latencyMs, input.usage?.inputTokens ?? null,
      input.usage?.cachedInputTokens ?? null, input.usage?.outputTokens ?? null, now);
  }

  recordFindingOutcome(runId: string, findingId: string, outcome: "confirmed" | "false_positive", now = new Date().toISOString()): void {
    this.requireRun(runId);
    this.database.prepare(
      `INSERT INTO finding_metrics (run_id, finding_id, outcome, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, finding_id) DO UPDATE SET outcome = excluded.outcome, created_at = excluded.created_at`,
    ).run(runId, findingId, outcome, now);
  }

  getRunMetrics(runId: string): RunMetrics {
    this.requireRun(runId);
    const calls = this.database.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(latency_ms), 0) AS latency,
       SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
       SUM(output_tokens) AS output_tokens FROM agent_call_metrics WHERE run_id = ?`,
    ).get(runId) as MetricAggregateRow;
    const findings = this.database.prepare(
      `SELECT COALESCE(SUM(outcome = 'confirmed'), 0) AS confirmed,
       COALESCE(SUM(outcome = 'false_positive'), 0) AS false_positives
       FROM finding_metrics WHERE run_id = ?`,
    ).get(runId) as FindingAggregateRow;
    return { agentCalls: calls.calls, latencyMs: calls.latency, inputTokens: calls.input_tokens,
      cachedInputTokens: calls.cached_input_tokens, outputTokens: calls.output_tokens,
      confirmedFindings: findings.confirmed, falsePositives: findings.false_positives };
  }

  private requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private writeRun(run: Run): void {
    this.database
      .prepare(
        `UPDATE runs SET status = ?, blocked_json = ?, merge_sha = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        run.status,
        run.blocked ? JSON.stringify(run.blocked) : null,
        run.mergeSha,
        run.updatedAt,
        run.id,
      );
  }

  private insertEvent(runId: string, type: string, data: unknown, now: string): number {
    const result = this.database
      .prepare("INSERT INTO events (run_id, type, data_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, type, JSON.stringify(data), now);
    return Number(result.lastInsertRowid);
  }

  private insertOutbox(runId: string, type: OutboxEventType, payload: unknown, now: string): number {
    const result = this.database.prepare(
      "INSERT INTO outbox (run_id, type, payload_json, created_at, delivered_at, attempts, last_error) VALUES (?, ?, ?, ?, NULL, 0, NULL)",
    ).run(runId, type, JSON.stringify(payload), now);
    return Number(result.lastInsertRowid);
  }

  private requireOutbox(id: number): OutboxRecord {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
    if (!row) throw new Error(`Outbox record not found: ${id}`);
    return mapOutbox(row);
  }

  private requireHumanInbox(id: number): HumanInboxRecord {
    const row = this.database.prepare("SELECT * FROM human_inbox WHERE id = ?").get(id) as HumanInboxRow | undefined;
    if (!row) throw new Error(`Human Inbox record not found: ${id}`);
    return mapHumanInbox(row);
  }

  private operationByKey(key: string): Operation | null {
    const row = this.database
      .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
      .get(key) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  private requireOperation(id: string): Operation {
    const operation = this.getOperation(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    return operation;
  }

  private requireEvidence(id: string): Evidence {
    const row = this.database.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
    if (!row) throw new Error(`Evidence not found: ${id}`);
    return mapEvidence(row);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        blocked_json TEXT,
        merge_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        operation_id TEXT REFERENCES operations(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        step_id TEXT NOT NULL,
        dependency_hash TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        UNIQUE(run_id, kind, dependency_hash)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS human_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        consequence TEXT NOT NULL,
        resume_command TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_call_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finding_metrics (
        run_id TEXT NOT NULL REFERENCES runs(id),
        finding_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('confirmed', 'false_positive')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, finding_id)
      );
    `);
  }
}

interface MetricAggregateRow { calls: number; latency: number; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null }
interface FindingAggregateRow { confirmed: number; false_positives: number }

interface RunRow {
  id: string;
  task_id: string;
  status: RunStatus;
  blocked_json: string | null;
  merge_sha: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  id: string;
  run_id: string;
  kind: string;
  idempotency_key: string;
  status: Operation["status"];
  result_json: string | null;
  started_at: string;
  finished_at: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  type: string;
  data_json: string;
  created_at: string;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  operation_id: string | null;
  kind: string;
  status: Evidence["status"];
  commit_sha: string;
  policy_version: string;
  step_id: string;
  dependency_hash: string;
  data_json: string;
  created_at: string;
  invalidated_at: string | null;
}

interface OutboxRow { id: number; run_id: string; type: OutboxEventType; payload_json: string; created_at: string; delivered_at: string | null; attempts: number; last_error: string | null }
interface HumanInboxRow { id: number; run_id: string; question: string; options_json: string; recommendation: string; evidence_json: string; risk: string; consequence: string; resume_command: string; created_at: string; resolved_at: string | null }

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    blocked: row.blocked_json ? parseJson(row.blocked_json) as Run["blocked"] : null,
    mergeSha: row.merge_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    result: row.result_json === null ? null : parseJson(row.result_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    runId: row.run_id,
    operationId: row.operation_id,
    kind: row.kind,
    status: row.status,
    commitSha: row.commit_sha,
    policyVersion: row.policy_version,
    stepId: row.step_id,
    dependencyHash: row.dependency_hash,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
  };
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return { id: row.id, runId: row.run_id, type: row.type, payload: parseJson(row.payload_json), createdAt: row.created_at, deliveredAt: row.delivered_at, attempts: row.attempts, lastError: row.last_error };
}

function mapHumanInbox(row: HumanInboxRow): HumanInboxRecord {
  return { id: row.id, runId: row.run_id, question: row.question, options: parseJson(row.options_json) as string[], recommendation: row.recommendation, evidence: parseJson(row.evidence_json), risk: row.risk, consequence: row.consequence, resumeCommand: row.resume_command, createdAt: row.created_at, resolvedAt: row.resolved_at };
}

function validateHumanInbox(input: HumanInboxInput): void {
  if (!input.question.trim() || input.options.length === 0 || input.options.some((option) => !option.trim()) ||
      !input.recommendation.trim() || !input.risk.trim() || !input.consequence.trim() || !input.resumeCommand.trim()) {
    throw new Error("Human Inbox requires question, options, recommendation, risk, consequence, and resume command");
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function contextualize(error: unknown, context: string): Error {
  return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}
