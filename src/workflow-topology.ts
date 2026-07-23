import {
  executionTemplates,
  type ExecutionTemplateName,
} from "./routing.js";
import { workflowEdgesForTemplate } from "./workflow-transition-registry.js";

export const workflowNodeIds = [
  "entry",
  "resolve-risk",
  "explore",
  "author",
  "checkpoint-commit",
  "bind-acceptance",
  "verify",
  "review",
  "repair",
  "ready",
] as const;

export type WorkflowNodeId = (typeof workflowNodeIds)[number];

export type WorkflowGuardId =
  | "risk-unknown"
  | "exploration-required"
  | "writer-required"
  | "writer-patch-ready"
  | "acceptance-binding-required"
  | "verification-required"
  | "verification-failed-repairable"
  | "review-required"
  | "review-blocking-repairable"
  | "ready-evidence-satisfied";

export type WorkflowBudgetId = "repair";
export type WorkflowEvidenceRequirement =
  | "writer-output"
  | "exploration"
  | "candidate-commit"
  | "acceptance-binding"
  | "verification-failure"
  | "verification"
  | "review-findings"
  | "review";
export type WorkflowExecutionMode =
  | "deterministic"
  | "read-only-agent"
  | "workspace-write-agent";
export type WorkflowEdgeKind = "forward" | "back";
export type WorkflowCheckpointPolicy = "none" | "clean-candidate-commit-required";

export interface WorkflowNode {
  id: WorkflowNodeId;
  executionMode: WorkflowExecutionMode;
}

export interface WorkflowEdge {
  id: string;
  from: WorkflowNodeId;
  to: WorkflowNodeId;
  kind: WorkflowEdgeKind;
  guard: WorkflowGuardId;
  budgetId: WorkflowBudgetId | null;
  requiredEvidenceKinds: readonly WorkflowEvidenceRequirement[];
  checkpointPolicy: WorkflowCheckpointPolicy;
}

export interface WorkflowBudgetPolicy {
  id: WorkflowBudgetId;
  maximumTraversals: number;
  exhaustionDisposition: "block";
}

export interface WorkflowTopologyManifest {
  schemaVersion: 1;
  template: ExecutionTemplateName;
  entryNode: "entry";
  readyNode: "ready";
  failureDisposition: "blocked";
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  budgets: readonly WorkflowBudgetPolicy[];
}

const node = (id: WorkflowNodeId, executionMode: WorkflowExecutionMode): WorkflowNode => ({
  id,
  executionMode,
});

const commonNodes: readonly WorkflowNode[] = [
  node("entry", "deterministic"),
  node("resolve-risk", "deterministic"),
  node("author", "workspace-write-agent"),
  node("checkpoint-commit", "deterministic"),
  node("verify", "deterministic"),
  node("repair", "workspace-write-agent"),
  node("ready", "deterministic"),
];

export function compileWorkflowTopology(
  template: ExecutionTemplateName,
): WorkflowTopologyManifest {
  const selectedNodes = template === "assisted"
    ? [...commonNodes.slice(0, 2), node("explore", "read-only-agent"), ...commonNodes.slice(2)]
    : template === "reviewed"
      ? [
          ...commonNodes.slice(0, 4),
          node("bind-acceptance", "deterministic"),
          commonNodes[4]!,
          node("review", "read-only-agent"),
          ...commonNodes.slice(5),
        ]
      : [...commonNodes];
  const selectedEdges = workflowEdgesForTemplate(template);

  return {
    schemaVersion: 1,
    template,
    entryNode: "entry",
    readyNode: "ready",
    failureDisposition: "blocked",
    nodes: selectedNodes.map((item) => ({ ...item })),
    edges: selectedEdges.map((item) => ({
      ...item,
      requiredEvidenceKinds: [...item.requiredEvidenceKinds],
    })),
    budgets: [{
      id: "repair",
      maximumTraversals: executionTemplates[template].maximumRepairs,
      exhaustionDisposition: "block",
    }],
  };
}
