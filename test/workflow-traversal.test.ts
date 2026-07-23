import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteStore,
  WorkflowBudgetExceededError,
  WorkflowTraversalConflictError,
  type ReserveWorkflowTraversalInput,
} from "../src/store.js";

const temporaryDirectories: string[] = [];

function createStore(): SqliteStore {
  const directory = mkdtempSync(join(tmpdir(), "agent-loop-workflow-traversal-"));
  temporaryDirectories.push(directory);
  return new SqliteStore(join(directory, "state.sqlite"));
}

function reservation(
  overrides: Partial<ReserveWorkflowTraversalInput> = {},
): ReserveWorkflowTraversalInput {
  return {
    id: "traversal-1",
    runId: "run-1",
    topologyHash: "topology-1",
    edgeId: "verify.repair",
    budgetId: "repair",
    maximumTraversals: 1,
    idempotencyKey: "key-1",
    sourceStateHash: "state-1",
    action: { kind: "repair", attempt: 1 },
    now: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function claim(
  store: SqliteStore,
  owner = "worker-1",
  now = "2026-07-21T00:00:00.000Z",
) {
  const lease = store.claimWorkflowTraversalExecution("traversal-1", owner, 60_000, now);
  expect(lease).not.toBeNull();
  return lease!;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workflow traversal persistence", () => {
  it("migrates to schema v3 with lookup and single-reservation indexes", () => {
    const store = createStore();
    expect(store.database.pragma("user_version", { simple: true })).toBe(3);
    const indexes = store.database.pragma("index_list(workflow_traversals)") as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workflow_traversals_run_edge" }),
      expect.objectContaining({ name: "workflow_traversals_run_budget" }),
      expect.objectContaining({
        name: "workflow_traversals_one_reserved_per_run",
        unique: 1,
        partial: 1,
      }),
    ]));
    store.close();
  });

  it("atomically reserves a receipt, counts it immediately, and emits a stable event", () => {
    const store = createStore();
    store.createRun("run-1", "task-1", "2026-07-21T00:00:00.000Z");

    const receipt = store.reserveWorkflowTraversal(reservation());

    expect(receipt).toMatchObject({
      id: "traversal-1",
      status: "reserved",
      budgetId: "repair",
      budgetOrdinal: 1,
      operationId: null,
      result: null,
      completedAt: null,
    });
    expect(store.getWorkflowTraversal(receipt.id)).toEqual(receipt);
    expect(store.listWorkflowTraversals("run-1")).toEqual([receipt]);
    expect(store.getPendingWorkflowTraversal("run-1")).toEqual(receipt);
    expect(store.workflowBudgetUsage("run-1", "repair")).toBe(1);
    expect(store.listEvents("run-1").at(-1)).toMatchObject({
      type: "workflow.edge.reserved",
      data: {
        traversalId: "traversal-1",
        edgeId: "verify.repair",
        budgetId: "repair",
        budgetOrdinal: 1,
      },
    });
    store.close();
  });

  it("returns the same receipt after a crash-like repeat without spending budget twice", () => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    const first = store.reserveWorkflowTraversal(reservation());
    const resumed = store.reserveWorkflowTraversal(reservation({
      now: "2026-07-21T00:01:00.000Z",
    }));

    expect(resumed).toEqual(first);
    expect(store.workflowBudgetUsage("run-1", "repair")).toBe(1);
    expect(store.listWorkflowTraversals("run-1")).toHaveLength(1);
    expect(store.listEvents("run-1").filter(({ type }) => type === "workflow.edge.reserved"))
      .toHaveLength(1);
    store.close();
  });

  it.each([
    ["id", { id: "different-traversal" }],
    ["topology hash", { topologyHash: "different-topology" }],
    ["edge", { edgeId: "review.repair" }],
    ["budget", { budgetId: null, maximumTraversals: undefined }],
    ["source state", { sourceStateHash: "different-state" }],
    ["action", { action: { kind: "repair" as const, attempt: 2 } }],
  ])("rejects an idempotency key reused with a different %s", (_label, override) => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    store.reserveWorkflowTraversal(reservation());

    expect(() => store.reserveWorkflowTraversal(reservation(override)))
      .toThrowError(WorkflowTraversalConflictError);
    expect(store.listWorkflowTraversals("run-1")).toHaveLength(1);
    store.close();
  });

  it("allows only one pending traversal for a run", () => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    store.reserveWorkflowTraversal(reservation());

    expect(() => store.reserveWorkflowTraversal(reservation({
      id: "traversal-2",
      edgeId: "repair.checkpoint",
      budgetId: null,
      maximumTraversals: undefined,
      idempotencyKey: "key-2",
      sourceStateHash: "state-2",
      action: { kind: "checkpoint-commit" },
    }))).toThrowError(WorkflowTraversalConflictError);
    store.close();
  });

  it.each([
    ["verify.repair", "review.repair"],
    ["review.repair", "verify.repair"],
  ])("shares the repair budget across %s then %s", (firstEdge, secondEdge) => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    store.reserveWorkflowTraversal(reservation({ edgeId: firstEdge }));
    const lease = claim(store);
    store.completeWorkflowTraversal(
      "traversal-1",
      { resultingRunStatus: "open" },
      lease,
      null,
      "2026-07-21T00:00:01.000Z",
    );

    let thrown: unknown;
    try {
      store.reserveWorkflowTraversal(reservation({
        id: "traversal-2",
        edgeId: secondEdge,
        idempotencyKey: "key-2",
        sourceStateHash: "state-2",
      }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowBudgetExceededError);
    expect(thrown).toMatchObject({
      code: "WORKFLOW_BUDGET_EXHAUSTED",
      runId: "run-1",
      budgetId: "repair",
      used: 1,
      maximumTraversals: 1,
    });
    expect(store.workflowBudgetUsage("run-1", "repair")).toBe(1);
    store.close();
  });

  it("completes atomically and makes an identical completion idempotent", () => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    store.reserveWorkflowTraversal(reservation());
    const operation = store.createOperation({
      id: "operation-1",
      runId: "run-1",
      kind: "repair",
      idempotencyKey: "operation-key-1",
    });
    const result = { resultingRunStatus: "open" };
    const lease = claim(store);

    const completed = store.completeWorkflowTraversal(
      "traversal-1",
      result,
      lease,
      operation.id,
      "2026-07-21T00:00:01.000Z",
    );
    const repeated = store.completeWorkflowTraversal(
      "traversal-1",
      result,
      lease,
      operation.id,
      "2026-07-21T00:00:02.000Z",
    );

    expect(completed).toMatchObject({
      status: "completed",
      operationId: "operation-1",
      result,
      completedAt: "2026-07-21T00:00:01.000Z",
    });
    expect(repeated).toEqual(completed);
    expect(store.getPendingWorkflowTraversal("run-1")).toBeNull();
    expect(store.listEvents("run-1").filter(({ type }) => type === "workflow.edge.completed"))
      .toHaveLength(1);
    expect(() => store.completeWorkflowTraversal("traversal-1", { different: true }, lease, operation.id))
      .toThrowError(WorkflowTraversalConflictError);
    store.close();
  });

  it("rolls back completion when its result event cannot be serialized", () => {
    const store = createStore();
    store.createRun("run-1", "task-1");
    store.reserveWorkflowTraversal(reservation());
    const lease = claim(store);

    let serializations = 0;
    const result = {
      toJSON(): unknown {
        serializations += 1;
        return serializations === 1 ? { stored: true } : { unsupported: 1n };
      },
    };
    expect(() => store.completeWorkflowTraversal("traversal-1", result, lease)).toThrow();
    expect(store.getWorkflowTraversal("traversal-1")?.status).toBe("reserved");
    expect(store.listEvents("run-1").some(({ type }) => type === "workflow.edge.completed"))
      .toBe(false);
    store.close();
  });

  it("allows only one live execution lease and fences an expired owner from completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-workflow-lease-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const first = new SqliteStore(path);
    first.createRun("run-1", "task-1");
    first.reserveWorkflowTraversal(reservation());
    const second = new SqliteStore(path);

    const firstLease = first.claimWorkflowTraversalExecution(
      "traversal-1", "worker-1", 60_000, "2026-07-21T00:00:00.000Z",
    );
    expect(firstLease).not.toBeNull();
    expect(second.claimWorkflowTraversalExecution(
      "traversal-1", "worker-2", 60_000, "2026-07-21T00:00:30.000Z",
    )).toBeNull();

    const takeover = second.claimWorkflowTraversalExecution(
      "traversal-1", "worker-2", 60_000, "2026-07-21T00:01:01.000Z",
    );
    expect(takeover).not.toBeNull();
    expect(() => first.completeWorkflowTraversal(
      "traversal-1", { resultingRunStatus: "open" }, firstLease!, null,
      "2026-07-21T00:01:02.000Z",
    )).toThrowError(WorkflowTraversalConflictError);
    expect(second.completeWorkflowTraversal(
      "traversal-1", { resultingRunStatus: "open" }, takeover!, null,
      "2026-07-21T00:01:02.000Z",
    )).toMatchObject({ status: "completed" });

    second.close();
    first.close();
  });
});
