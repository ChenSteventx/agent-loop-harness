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
    `);
  }
}

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

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function contextualize(error: unknown, context: string): Error {
  return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}
