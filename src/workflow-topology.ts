import {
  executionTemplates,
  type ExecutionTemplateName,
} from "./routing.js";

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
  requiredEvidenceKinds: readonly string[];
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

const edge = (
  id: string,
  from: WorkflowNodeId,
  to: WorkflowNodeId,
  guard: WorkflowGuardId,
  options: {
    kind?: WorkflowEdgeKind;
    budgetId?: WorkflowBudgetId | null;
    requiredEvidenceKinds?: readonly string[];
    checkpointPolicy?: WorkflowCheckpointPolicy;
  } = {},
): WorkflowEdge => ({
  id,
  from,
  to,
  kind: options.kind ?? "forward",
  guard,
  budgetId: options.budgetId ?? null,
  requiredEvidenceKinds: options.requiredEvidenceKinds ?? [],
  checkpointPolicy: options.checkpointPolicy ?? "none",
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

const commonEntryEdges: readonly WorkflowEdge[] = [
  edge("entry.resolve-risk", "entry", "resolve-risk", "risk-unknown"),
];

const commonWriterEdges: readonly WorkflowEdge[] = [
  edge("author.checkpoint", "author", "checkpoint-commit", "writer-patch-ready", {
    requiredEvidenceKinds: ["writer-output"],
  }),
  edge("repair.checkpoint", "repair", "checkpoint-commit", "writer-patch-ready", {
    requiredEvidenceKinds: ["writer-output"],
  }),
];

const verifyRepairEdge = edge(
  "verify.repair",
  "verify",
  "repair",
  "verification-failed-repairable",
  {
    kind: "back",
    budgetId: "repair",
    requiredEvidenceKinds: ["verification-failure"],
    checkpointPolicy: "clean-candidate-commit-required",
  },
);

function soloOrAssistedEdges(template: "solo" | "assisted"): readonly WorkflowEdge[] {
  const entryEdges = template === "assisted"
    ? [
        edge("entry.explore", "entry", "explore", "exploration-required"),
        edge("explore.author", "explore", "author", "writer-required", {
          requiredEvidenceKinds: ["exploration"],
        }),
      ]
    : [edge("entry.author", "entry", "author", "writer-required")];

  return [
    ...commonEntryEdges,
    ...entryEdges,
    ...commonWriterEdges,
    edge("checkpoint.verify", "checkpoint-commit", "verify", "verification-required", {
      requiredEvidenceKinds: ["candidate-commit"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    verifyRepairEdge,
    edge("verify.ready", "verify", "ready", "ready-evidence-satisfied", {
      requiredEvidenceKinds: ["verification"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
  ];
}

function reviewedEdges(): readonly WorkflowEdge[] {
  return [
    ...commonEntryEdges,
    edge("entry.author", "entry", "author", "writer-required"),
    ...commonWriterEdges,
    edge(
      "checkpoint.acceptance",
      "checkpoint-commit",
      "bind-acceptance",
      "acceptance-binding-required",
      {
        requiredEvidenceKinds: ["candidate-commit"],
        checkpointPolicy: "clean-candidate-commit-required",
      },
    ),
    edge("acceptance.verify", "bind-acceptance", "verify", "verification-required", {
      requiredEvidenceKinds: ["acceptance-binding"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    verifyRepairEdge,
    edge("verify.review", "verify", "review", "review-required", {
      requiredEvidenceKinds: ["verification"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    edge("review.repair", "review", "repair", "review-blocking-repairable", {
      kind: "back",
      budgetId: "repair",
      requiredEvidenceKinds: ["review-findings"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    edge("review.ready", "review", "ready", "ready-evidence-satisfied", {
      requiredEvidenceKinds: ["verification", "review"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
  ];
}

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
  const selectedEdges = template === "reviewed" ? reviewedEdges() : soloOrAssistedEdges(template);

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
