import { describe, expect, it } from "vitest";
import {
  compileWorkflowTopology,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTopologyManifest,
} from "../src/workflow-topology.js";
import {
  validateWorkflowTopology,
  WorkflowTopologyValidationError,
  type WorkflowTopologyErrorCode,
} from "../src/workflow-validator.js";

const withEdges = (
  manifest: WorkflowTopologyManifest,
  edges: readonly WorkflowEdge[],
): WorkflowTopologyManifest => ({ ...manifest, edges });

const withNodes = (
  manifest: WorkflowTopologyManifest,
  nodes: readonly WorkflowNode[],
): WorkflowTopologyManifest => ({ ...manifest, nodes });

function expectCode(manifest: WorkflowTopologyManifest, code: WorkflowTopologyErrorCode): void {
  try {
    validateWorkflowTopology(manifest);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowTopologyValidationError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).toMatch(new RegExp(`^${code}:`));
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("validateWorkflowTopology", () => {
  it.each(["solo", "assisted", "reviewed"] as const)("accepts the compiled %s topology", (template) => {
    expect(validateWorkflowTopology(compileWorkflowTopology(template))).toBeUndefined();
  });

  it("rejects an unknown execution template at the runtime boundary", () => {
    const manifest = {
      ...compileWorkflowTopology("solo"),
      template: "unregistered",
    } as unknown as WorkflowTopologyManifest;
    expectCode(manifest, "WORKFLOW_TEMPLATE_INVALID");
  });

  it("rejects duplicate node identifiers", () => {
    const manifest = compileWorkflowTopology("solo");
    expectCode(withNodes(manifest, [...manifest.nodes, manifest.nodes[0]!]), "WORKFLOW_NODE_DUPLICATED");
  });

  it("rejects duplicate edge identifiers", () => {
    const manifest = compileWorkflowTopology("solo");
    expectCode(withEdges(manifest, [...manifest.edges, manifest.edges[0]!]), "WORKFLOW_EDGE_DUPLICATED");
  });

  it("rejects edges whose endpoints are missing", () => {
    const manifest = compileWorkflowTopology("solo");
    const edge = { ...manifest.edges[1]!, to: "explore" as const };
    expectCode(withEdges(manifest, [manifest.edges[0]!, edge, ...manifest.edges.slice(2)]), "WORKFLOW_EDGE_ENDPOINT_MISSING");
  });

  it("rejects declared nodes that cannot be reached from entry", () => {
    const manifest = compileWorkflowTopology("assisted");
    const edges = manifest.edges.filter((edge) => edge.id !== "entry.explore");
    expectCode(withEdges(manifest, edges), "WORKFLOW_NODE_UNREACHABLE");
  });

  it("reports the stable ready-specific error when ready is unreachable", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.filter((edge) => edge.to !== "ready");
    expectCode(withEdges(manifest, edges), "WORKFLOW_READY_UNREACHABLE");
  });

  it("rejects unbudgeted back edges", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.map((edge) => edge.id === "verify.repair"
      ? { ...edge, budgetId: null }
      : edge);
    expectCode(withEdges(manifest, edges), "WORKFLOW_BACK_EDGE_UNBUDGETED");
  });

  it("treats a missing shared repair budget as an unbudgeted back edge", () => {
    const manifest = compileWorkflowTopology("solo");
    expectCode({ ...manifest, budgets: [] }, "WORKFLOW_BACK_EDGE_UNBUDGETED");
  });

  it("rejects back edges other than the two approved repair edges", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.map((edge) => edge.id === "verify.repair"
      ? { ...edge, id: "checkpoint.repair", from: "checkpoint-commit" as const }
      : edge);
    expectCode(withEdges(manifest, edges), "WORKFLOW_BACK_EDGE_INVALID");
  });

  it("rejects a cycle that remains after removing back edges", () => {
    const manifest = compileWorkflowTopology("solo");
    const cycle: WorkflowEdge = {
      id: "verify.checkpoint",
      from: "verify",
      to: "checkpoint-commit",
      kind: "forward",
      guard: "verification-required",
      budgetId: null,
      requiredEvidenceKinds: [],
      checkpointPolicy: "none",
    };
    expectCode(withEdges(manifest, [...manifest.edges, cycle]), "WORKFLOW_FORWARD_GRAPH_CYCLIC");
  });

  it("rejects outgoing edges from ready", () => {
    const manifest = compileWorkflowTopology("solo");
    const edge: WorkflowEdge = {
      id: "ready.author",
      from: "ready",
      to: "author",
      kind: "forward",
      guard: "writer-required",
      budgetId: null,
      requiredEvidenceKinds: [],
      checkpointPolicy: "none",
    };
    expectCode(withEdges(manifest, [...manifest.edges, edge]), "WORKFLOW_READY_HAS_OUTGOING_EDGE");
  });

  it("rejects paths to ready that bypass verification", () => {
    const manifest = compileWorkflowTopology("solo");
    const bypass: WorkflowEdge = {
      id: "checkpoint.ready",
      from: "checkpoint-commit",
      to: "ready",
      kind: "forward",
      guard: "ready-evidence-satisfied",
      budgetId: null,
      requiredEvidenceKinds: [],
      checkpointPolicy: "clean-candidate-commit-required",
    };
    expectCode(
      withEdges(manifest, [...manifest.edges, bypass]),
      "WORKFLOW_READY_BYPASSES_VERIFICATION",
    );
  });

  it("rejects reviewed paths to ready that bypass review", () => {
    const manifest = compileWorkflowTopology("reviewed");
    const bypass: WorkflowEdge = {
      id: "verify.ready",
      from: "verify",
      to: "ready",
      kind: "forward",
      guard: "ready-evidence-satisfied",
      budgetId: null,
      requiredEvidenceKinds: ["verification"],
      checkpointPolicy: "clean-candidate-commit-required",
    };
    expectCode(withEdges(manifest, [...manifest.edges, bypass]), "WORKFLOW_READY_BYPASSES_REVIEW");
  });

  it("rejects assisted paths to author that bypass explore", () => {
    const manifest = compileWorkflowTopology("assisted");
    const bypass: WorkflowEdge = {
      id: "entry.author",
      from: "entry",
      to: "author",
      kind: "forward",
      guard: "writer-required",
      budgetId: null,
      requiredEvidenceKinds: [],
      checkpointPolicy: "none",
    };
    expectCode(
      withEdges(manifest, [...manifest.edges, bypass]),
      "WORKFLOW_AUTHOR_BYPASSES_EXPLORATION",
    );
  });

  it("rejects write authority outside author and repair", () => {
    const manifest = compileWorkflowTopology("solo");
    const nodes = manifest.nodes.map((node) => node.id === "verify"
      ? { ...node, executionMode: "workspace-write-agent" as const }
      : node);
    expectCode(withNodes(manifest, nodes), "WORKFLOW_WRITE_AUTHORITY_INVALID");
  });

  it("rejects an invalid or template-mismatched repair budget", () => {
    const manifest = compileWorkflowTopology("solo");
    expectCode(
      { ...manifest, budgets: [{ ...manifest.budgets[0]!, maximumTraversals: Number.POSITIVE_INFINITY }] },
      "WORKFLOW_BUDGET_INVALID",
    );

    expectCode(
      { ...manifest, budgets: [{ ...manifest.budgets[0]!, maximumTraversals: 0 }] },
      "WORKFLOW_BUDGET_INVALID",
    );
  });

  it("rejects unknown Evidence requirements at the runtime boundary", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.map((edge, index) => index === 0
      ? { ...edge, requiredEvidenceKinds: ["unknown-proof"] } as unknown as WorkflowEdge
      : edge);
    expectCode(withEdges(manifest, edges), "WORKFLOW_EVIDENCE_REQUIREMENT_INVALID");
  });

  it("rejects unknown checkpoint policies at the runtime boundary", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.map((edge, index) => index === 0
      ? { ...edge, checkpointPolicy: "trust-me" } as unknown as WorkflowEdge
      : edge);
    expectCode(withEdges(manifest, edges), "WORKFLOW_CHECKPOINT_POLICY_INVALID");
  });

  it("rejects a manifest whose declared template is not its registry projection", () => {
    const assisted = compileWorkflowTopology("assisted");
    expectCode(
      { ...assisted, template: "solo" },
      "WORKFLOW_REGISTRY_PROJECTION_MISMATCH",
    );
  });

  it("rejects registered edge metadata drift even when graph structure remains valid", () => {
    const manifest = compileWorkflowTopology("solo");
    const edges = manifest.edges.map((edge) => edge.id === "entry.author"
      ? { ...edge, guard: "risk-unknown" as const }
      : edge);
    expectCode(withEdges(manifest, edges), "WORKFLOW_REGISTRY_PROJECTION_MISMATCH");
  });

  it("rejects registered node execution-mode drift", () => {
    const manifest = compileWorkflowTopology("solo");
    const nodes = manifest.nodes.map((node) => node.id === "verify"
      ? { ...node, executionMode: "read-only-agent" as const }
      : node);
    expectCode(withNodes(manifest, nodes), "WORKFLOW_REGISTRY_PROJECTION_MISMATCH");
  });
});
