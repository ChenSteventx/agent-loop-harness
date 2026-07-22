import { executionTemplates } from "./routing.js";
import type {
  WorkflowBudgetPolicy,
  WorkflowEdge,
  WorkflowNodeId,
  WorkflowTopologyManifest,
} from "./workflow-topology.js";

export type WorkflowTopologyErrorCode =
  | "WORKFLOW_NODE_DUPLICATED"
  | "WORKFLOW_EDGE_DUPLICATED"
  | "WORKFLOW_BUDGET_DUPLICATED"
  | "WORKFLOW_ENTRY_NODE_MISSING"
  | "WORKFLOW_READY_NODE_MISSING"
  | "WORKFLOW_EDGE_ENDPOINT_MISSING"
  | "WORKFLOW_NODE_UNREACHABLE"
  | "WORKFLOW_READY_UNREACHABLE"
  | "WORKFLOW_READY_HAS_OUTGOING_EDGE"
  | "WORKFLOW_FORWARD_GRAPH_CYCLIC"
  | "WORKFLOW_BACK_EDGE_UNBUDGETED"
  | "WORKFLOW_BACK_EDGE_INVALID"
  | "WORKFLOW_BUDGET_INVALID"
  | "WORKFLOW_FORWARD_EDGE_BUDGETED"
  | "WORKFLOW_READY_BYPASSES_VERIFICATION"
  | "WORKFLOW_READY_BYPASSES_REVIEW"
  | "WORKFLOW_AUTHOR_BYPASSES_EXPLORATION"
  | "WORKFLOW_WRITE_AUTHORITY_INVALID";

export class WorkflowTopologyValidationError extends Error {
  readonly name = "WorkflowTopologyValidationError";

  constructor(
    readonly code: WorkflowTopologyErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
  }
}

const fail = (
  code: WorkflowTopologyErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never => {
  throw new WorkflowTopologyValidationError(code, message, details);
};

export function validateWorkflowTopology(manifest: WorkflowTopologyManifest): void {
  const nodeIds = new Set<string>();
  for (const node of manifest.nodes) {
    if (nodeIds.has(node.id)) {
      fail("WORKFLOW_NODE_DUPLICATED", `Node ${node.id} is declared more than once`, { nodeId: node.id });
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of manifest.edges) {
    if (edgeIds.has(edge.id)) {
      fail("WORKFLOW_EDGE_DUPLICATED", `Edge ${edge.id} is declared more than once`, { edgeId: edge.id });
    }
    edgeIds.add(edge.id);
  }

  const budgets = budgetMap(manifest.budgets);

  if (!nodeIds.has(manifest.entryNode)) {
    fail("WORKFLOW_ENTRY_NODE_MISSING", `Entry node ${manifest.entryNode} is not declared`, {
      entryNode: manifest.entryNode,
    });
  }
  if (!nodeIds.has(manifest.readyNode)) {
    fail("WORKFLOW_READY_NODE_MISSING", `Ready node ${manifest.readyNode} is not declared`, {
      readyNode: manifest.readyNode,
    });
  }

  for (const edge of manifest.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      fail("WORKFLOW_EDGE_ENDPOINT_MISSING", `Edge ${edge.id} refers to an undeclared endpoint`, {
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
      });
    }
    validateEdgeBudget(edge, budgets);
  }

  const repairBudget = budgets.get("repair");
  if (
    !repairBudget ||
    repairBudget.maximumTraversals !== executionTemplates[manifest.template].maximumRepairs
  ) {
    fail(
      "WORKFLOW_BUDGET_INVALID",
      `Repair budget must match the ${manifest.template} execution template`,
      {
        maximumTraversals: repairBudget?.maximumTraversals ?? null,
        expectedMaximumTraversals: executionTemplates[manifest.template].maximumRepairs,
      },
    );
  }

  for (const node of manifest.nodes) {
    if (node.id === manifest.readyNode) continue;
    if (!isReachable(manifest, manifest.entryNode, node.id)) {
      fail("WORKFLOW_NODE_UNREACHABLE", `Node ${node.id} is not reachable from entry`, {
        nodeId: node.id,
      });
    }
  }

  if (!isReachable(manifest, manifest.entryNode, manifest.readyNode)) {
    fail("WORKFLOW_READY_UNREACHABLE", "The ready node is not reachable from entry");
  }

  const outgoingFromReady = manifest.edges.find((edge) => edge.from === manifest.readyNode);
  if (outgoingFromReady) {
    fail("WORKFLOW_READY_HAS_OUTGOING_EDGE", "The ready node must not have outgoing edges", {
      edgeId: outgoingFromReady.id,
    });
  }

  validateForwardDag(manifest);
  validateDominators(manifest);
  validateWriteAuthority(manifest);
}

function budgetMap(budgets: readonly WorkflowBudgetPolicy[]): Map<string, WorkflowBudgetPolicy> {
  const result = new Map<string, WorkflowBudgetPolicy>();
  for (const budget of budgets) {
    if (result.has(budget.id)) {
      fail("WORKFLOW_BUDGET_DUPLICATED", `Budget ${budget.id} is declared more than once`, {
        budgetId: budget.id,
      });
    }
    if (
      budget.id !== "repair" ||
      !Number.isSafeInteger(budget.maximumTraversals) ||
      budget.maximumTraversals < 0 ||
      budget.exhaustionDisposition !== "block"
    ) {
      fail("WORKFLOW_BUDGET_INVALID", `Budget ${budget.id} is not a finite blocking repair budget`, {
        budgetId: budget.id,
        maximumTraversals: budget.maximumTraversals,
      });
    }
    result.set(budget.id, budget);
  }
  return result;
}

function validateEdgeBudget(
  edge: WorkflowEdge,
  budgets: ReadonlyMap<string, WorkflowBudgetPolicy>,
): void {
  if (edge.kind === "forward") {
    if (edge.budgetId !== null) {
      fail("WORKFLOW_FORWARD_EDGE_BUDGETED", `Forward edge ${edge.id} must not consume a back-edge budget`, {
        edgeId: edge.id,
        budgetId: edge.budgetId,
      });
    }
    return;
  }

  const allowed =
    (edge.id === "verify.repair" && edge.from === "verify" && edge.to === "repair") ||
    (edge.id === "review.repair" && edge.from === "review" && edge.to === "repair");
  if (!allowed) {
    fail("WORKFLOW_BACK_EDGE_INVALID", `Back edge ${edge.id} is not an approved repair edge`, {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
    });
  }
  if (edge.budgetId === null || !budgets.has(edge.budgetId)) {
    fail("WORKFLOW_BACK_EDGE_UNBUDGETED", `Back edge ${edge.id} has no declared finite budget`, {
      edgeId: edge.id,
      budgetId: edge.budgetId,
    });
  }
  if (edge.budgetId !== "repair") {
    fail("WORKFLOW_BACK_EDGE_INVALID", `Back edge ${edge.id} must use the shared repair budget`, {
      edgeId: edge.id,
      budgetId: edge.budgetId,
    });
  }
}

function validateForwardDag(manifest: WorkflowTopologyManifest): void {
  const indegree = new Map<string, number>(manifest.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of manifest.edges) {
    if (edge.kind !== "forward") continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }

  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== manifest.nodes.length) {
    fail("WORKFLOW_FORWARD_GRAPH_CYCLIC", "The graph still contains a cycle after removing back edges");
  }
}

function validateDominators(manifest: WorkflowTopologyManifest): void {
  if (!hasNode(manifest, "verify") || isReachable(manifest, manifest.entryNode, manifest.readyNode, "verify")) {
    fail(
      "WORKFLOW_READY_BYPASSES_VERIFICATION",
      "Every path from entry to ready must pass through verify",
    );
  }

  if (
    manifest.template === "reviewed" &&
    (!hasNode(manifest, "review") || isReachable(manifest, manifest.entryNode, manifest.readyNode, "review"))
  ) {
    fail("WORKFLOW_READY_BYPASSES_REVIEW", "Every reviewed path to ready must pass through review");
  }

  if (
    manifest.template === "assisted" &&
    (!hasNode(manifest, "explore") || isReachable(manifest, manifest.entryNode, "author", "explore"))
  ) {
    fail(
      "WORKFLOW_AUTHOR_BYPASSES_EXPLORATION",
      "Every assisted path from entry to author must pass through explore",
    );
  }
}

function validateWriteAuthority(manifest: WorkflowTopologyManifest): void {
  for (const node of manifest.nodes) {
    const shouldWrite = node.id === "author" || node.id === "repair";
    const canWrite = node.executionMode === "workspace-write-agent";
    if (shouldWrite !== canWrite) {
      fail(
        "WORKFLOW_WRITE_AUTHORITY_INVALID",
        `Node ${node.id} has invalid workspace-write authority`,
        { nodeId: node.id, executionMode: node.executionMode },
      );
    }
  }
}

function hasNode(manifest: WorkflowTopologyManifest, nodeId: WorkflowNodeId): boolean {
  return manifest.nodes.some((node) => node.id === nodeId);
}

function isReachable(
  manifest: WorkflowTopologyManifest,
  start: WorkflowNodeId,
  target: WorkflowNodeId,
  omittedNode?: WorkflowNodeId,
): boolean {
  if (start === omittedNode || target === omittedNode) return false;
  const outgoing = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  for (const edge of manifest.edges) {
    if (edge.from === omittedNode || edge.to === omittedNode) continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }

  const visited = new Set<WorkflowNodeId>();
  const queue: WorkflowNodeId[] = [start];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}
