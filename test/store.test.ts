import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-loop-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteStore", () => {
  it("migrates legacy databases fail-closed without inventing bindings or Evidence dependencies", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, blocked_json TEXT,
        merge_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, result_json TEXT,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT REFERENCES operations(id),
        kind TEXT NOT NULL, status TEXT NOT NULL, commit_sha TEXT NOT NULL, policy_version TEXT NOT NULL,
        step_id TEXT NOT NULL, dependency_hash TEXT NOT NULL, data_json TEXT NOT NULL,
        created_at TEXT NOT NULL, invalidated_at TEXT, UNIQUE(run_id, kind, dependency_hash)
      );
      INSERT INTO runs VALUES ('legacy', 'task', 'open', NULL, NULL, '2026-01-01', '2026-01-01');
      INSERT INTO evidence VALUES (
        'legacy-e', 'legacy', NULL, 'command', 'valid', 'head', 'v1', 'verify:test',
        'old-hash', '{}', '2026-01-01', NULL
      );
    `);
    legacy.close();

    const migrated = new SqliteStore(path);
    expect(migrated.getRun("legacy")?.binding).toBeNull();
    expect(migrated.listEvidence("legacy")[0]).toMatchObject({
      status: "invalid", dependencyVersion: null, dependencies: null,
    });
    const operationColumns = migrated.database.pragma("table_info(operations)") as Array<{ name: string }>;
    expect(operationColumns.map(({ name }) => name)).toEqual(expect.arrayContaining(["input_json", "input_hash"]));
    expect(migrated.database.pragma("user_version", { simple: true })).toBe(3);
    migrated.close();
  });

  it("rolls back the run update when its event cannot be serialized", () => {
    const store = new SqliteStore(databasePath());
    store.createRun("run-1", "task-1");

    expect(() => store.transitionRun("run-1", "ready", {}, { unsupported: 1n })).toThrow(
      "Cannot transition",
    );
    expect(store.getRun("run-1")?.status).toBe("open");
    expect(store.listEvents("run-1").map((event) => event.type)).toEqual(["run.created"]);
    store.close();
  });

  it("installs an operation result once for an idempotency key", () => {
    const store = new SqliteStore(databasePath());
    store.createRun("run-1", "task-1");
    const first = store.createOperation({
      id: "op-1",
      runId: "run-1",
      kind: "author",
      idempotencyKey: "run-1:author",
    });
    const duplicate = store.createOperation({
      id: "op-2",
      runId: "run-1",
      kind: "author",
      idempotencyKey: "run-1:author",
    });

    expect(duplicate.id).toBe(first.id);
    expect(store.finishOperation(first.id, "succeeded", { patch: "abc" }).status).toBe("succeeded");
    expect(store.finishOperation(first.id, "succeeded", { patch: "abc" }).result).toEqual({ patch: "abc" });
    expect(() => store.finishOperation(first.id, "failed", { reason: "different" })).toThrow(
      "already succeeded",
    );
    store.close();
  });

  it("persists runs, events, operations, and evidence across reopen", () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    first.createRun("run-1", "task-1");
    first.transitionRun("run-1", "ready");
    const operation = first.createOperation({
      id: "op-1",
      runId: "run-1",
      kind: "verify",
      idempotencyKey: "run-1:verify:head-1",
    });
    first.installEvidence({
      id: "evidence-1",
      runId: "run-1",
      operationId: operation.id,
      kind: "command",
      commitSha: "head-1",
      policyVersion: "v1",
      stepId: "test",
      dependencyHash: "dep-1",
      data: { exitCode: 0 },
    });
    first.close();

    const reopened = new SqliteStore(path);
    expect(reopened.getRun("run-1")?.status).toBe("ready");
    expect(reopened.listEvents("run-1")).toHaveLength(2);
    expect(reopened.getOperation("op-1")?.status).toBe("running");
    expect(reopened.listEvidence("run-1")[0]?.data).toEqual({ exitCode: 0 });
    reopened.close();
  });

  it("enforces lifecycle transitions through persistence", () => {
    const store = new SqliteStore(databasePath());
    store.createRun("run-1", "task-1");
    expect(() => store.transitionRun("run-1", "done")).toThrow("Illegal run transition");
    store.transitionRun("run-1", "ready");
    expect(store.transitionRun("run-1", "merged", { mergeSha: "merge-1" }).mergeSha).toBe(
      "merge-1",
    );
    expect(store.transitionRun("run-1", "done").status).toBe("done");
    store.close();
  });

  it("writes lifecycle results and their notifications transactionally", () => {
    const store = new SqliteStore(databasePath());
    store.createRun("run-1", "task-1");
    store.transitionRun("run-1", "ready", {}, { commit: "head-1" });
    expect(store.listPendingOutbox()).toEqual([
      expect.objectContaining({ runId: "run-1", type: "ready", payload: { commit: "head-1" } }),
    ]);
    expect(() => store.transitionRun("run-1", "merged", { mergeSha: "m" }, { bad: 1n })).toThrow();
    expect(store.getRun("run-1")?.status).toBe("ready");
    store.close();
  });

  it("creates a complete Human Inbox record and needs-human Outbox item atomically", () => {
    const store = new SqliteStore(databasePath());
    store.createRun("run-1", "task-1");
    const item = store.createHumanInbox("run-1", {
      question: "Proceed without an independent reviewer?",
      options: ["wait", "cancel"],
      recommendation: "wait",
      evidence: { unavailable: ["Claude", "DeepSeek"] },
      risk: "high",
      consequence: "No independent receipt can be issued",
      resumeCommand: "npm run loop -- resume run-1",
    });
    expect(item).toMatchObject({ question: "Proceed without an independent reviewer?", risk: "high" });
    expect(store.listPendingOutbox()[0]).toMatchObject({ type: "needs-human" });
    store.close();
  });

  it("opens read-only for sidecar consumers and mechanically rejects writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-store-readonly-"));
    const path = join(directory, "state.sqlite");
    try {
      const writable = new SqliteStore(path);
      writable.createRun("readonly-run", "task-1");
      writable.close();
      const readOnly = new SqliteStore(path, { readOnly: true });
      expect(readOnly.getRun("readonly-run")?.id).toBe("readonly-run");
      expect(() => readOnly.database.exec("DELETE FROM runs")).toThrow(/readonly/iu);
      readOnly.close();
      expect(() => new SqliteStore(join(directory, "missing.sqlite"), { readOnly: true })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
