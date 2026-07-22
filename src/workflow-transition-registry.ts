import { readyEvidenceSatisfied } from "./evidence-gate.js";
import type { NextAction, ProofGapSnapshot, WorkflowDecision } from "./loop.js";
import type { ExecutionTemplateName } from "./routing.js";
import type {
  WorkflowCheckpointPolicy,
  WorkflowEdge,
  WorkflowEvidenceRequirement,
  WorkflowGuardId,
  WorkflowTopologyManifest,
} from "./workflow-topology.js";

const everyTemplate = ["solo", "assisted", "reviewed"] as const;

type WorkflowActionFactory = (budgetOrdinal: number | null) => NextAction | null;

export interface WorkflowEdgeRule {
  ruleKind: "edge";
  decisionOrder: number;
  templates: readonly ExecutionTemplateName[];
  edge: WorkflowEdge;
  matches: (snapshot: ProofGapSnapshot) => boolean;
  budgetOrdinal: (snapshot: ProofGapSnapshot) => number | null;
  actionForReceipt: WorkflowActionFactory;
}

interface WorkflowBlockRule {
  ruleKind: "block";
  decisionOrder: number;
  matches: (snapshot: ProofGapSnapshot) => boolean;
  reason: string;
}

export type WorkflowPolicyRule = WorkflowEdgeRule | WorkflowBlockRule;

export interface WorkflowTransitionProof {
  registered: boolean;
  guardSatisfied: boolean;
  requirementsSatisfied: boolean;
  checkpointSatisfied: boolean;
  satisfied: boolean;
  unknownRequirements: readonly string[];
}

const workflowEvidenceRequirementEvaluators = {
  "writer-output": (snapshot: ProofGapSnapshot) => snapshot.writer === "patch-ready",
  exploration: (snapshot: ProofGapSnapshot) => snapshot.exploration === "satisfied",
  "candidate-commit": (snapshot: ProofGapSnapshot) => snapshot.writer === "committed",
  "acceptance-binding": (snapshot: ProofGapSnapshot) => snapshot.acceptance === "satisfied",
  "verification-failure": (snapshot: ProofGapSnapshot) => snapshot.verification === "failed",
  verification: (snapshot: ProofGapSnapshot) => snapshot.verification === "passed",
  "review-findings": (snapshot: ProofGapSnapshot) => snapshot.review === "blocking",
  review: (snapshot: ProofGapSnapshot) => snapshot.review === "passed",
} satisfies Record<WorkflowEvidenceRequirement, (snapshot: ProofGapSnapshot) => boolean>;

export const workflowEvidenceRequirements: readonly WorkflowEvidenceRequirement[] = Object.freeze(
  Object.keys(workflowEvidenceRequirementEvaluators) as WorkflowEvidenceRequirement[],
);

const workflowEvidenceRequirementSet = new Set<string>(workflowEvidenceRequirements);

export function isWorkflowEvidenceRequirement(value: string): value is WorkflowEvidenceRequirement {
  return workflowEvidenceRequirementSet.has(value);
}

const staticAction = (action: Exclude<NextAction, { kind: "repair" | "block" }>): WorkflowActionFactory =>
  (budgetOrdinal) => budgetOrdinal === null ? { ...action } : null;

const repairAction: WorkflowActionFactory = (budgetOrdinal) =>
  budgetOrdinal !== null && Number.isSafeInteger(budgetOrdinal) && budgetOrdinal > 0
    ? { kind: "repair", attempt: budgetOrdinal }
    : null;

const edge = (
  decisionOrder: number,
  templates: readonly ExecutionTemplateName[],
  value: WorkflowEdge,
  matches: (snapshot: ProofGapSnapshot) => boolean,
  actionForReceipt: WorkflowActionFactory,
  budgetOrdinal: (snapshot: ProofGapSnapshot) => number | null = () => null,
): WorkflowEdgeRule => ({
  ruleKind: "edge",
  decisionOrder,
  templates,
  edge: value,
  matches,
  actionForReceipt,
  budgetOrdinal,
});

const block = (
  decisionOrder: number,
  reason: string,
  matches: (snapshot: ProofGapSnapshot) => boolean,
): WorkflowBlockRule => ({ ruleKind: "block", decisionOrder, reason, matches });

const workflowEdge = (
  id: string,
  from: WorkflowEdge["from"],
  to: WorkflowEdge["to"],
  guard: WorkflowGuardId,
  options: {
    kind?: WorkflowEdge["kind"];
    budgetId?: WorkflowEdge["budgetId"];
    requiredEvidenceKinds?: readonly WorkflowEvidenceRequirement[];
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

const nextRepairOrdinal = (snapshot: ProofGapSnapshot): number =>
  snapshot.writer === "running" ? snapshot.repairsUsed : snapshot.repairsUsed + 1;

const edgeRules: readonly WorkflowEdgeRule[] = [
  edge(
    10,
    everyTemplate,
    workflowEdge("entry.resolve-risk", "entry", "resolve-risk", "risk-unknown"),
    (snapshot) => snapshot.risk === "unknown",
    staticAction({ kind: "resolve-risk" }),
  ),
  edge(
    30,
    ["assisted"],
    workflowEdge("entry.explore", "entry", "explore", "exploration-required"),
    (snapshot) => snapshot.exploration === "missing",
    staticAction({ kind: "explore" }),
  ),
  edge(
    40,
    ["assisted"],
    workflowEdge("explore.author", "explore", "author", "writer-required", {
      requiredEvidenceKinds: ["exploration"],
    }),
    (snapshot) =>
      snapshot.exploration === "satisfied" &&
      (snapshot.writer === "missing" || (snapshot.writer === "running" && snapshot.repairsUsed === 0)),
    staticAction({ kind: "author", attempt: 1 }),
  ),
  edge(
    40,
    ["solo", "reviewed"],
    workflowEdge("entry.author", "entry", "author", "writer-required"),
    (snapshot) =>
      snapshot.exploration === "not-required" &&
      (snapshot.writer === "missing" || (snapshot.writer === "running" && snapshot.repairsUsed === 0)),
    staticAction({ kind: "author", attempt: 1 }),
  ),
  edge(
    50,
    everyTemplate,
    workflowEdge("author.checkpoint", "author", "checkpoint-commit", "writer-patch-ready", {
      requiredEvidenceKinds: ["writer-output"],
    }),
    (snapshot) => snapshot.writer === "patch-ready" && snapshot.repairsUsed === 0,
    staticAction({ kind: "checkpoint-commit" }),
  ),
  edge(
    50,
    everyTemplate,
    workflowEdge("repair.checkpoint", "repair", "checkpoint-commit", "writer-patch-ready", {
      requiredEvidenceKinds: ["writer-output"],
    }),
    (snapshot) => snapshot.writer === "patch-ready" && snapshot.repairsUsed > 0,
    staticAction({ kind: "checkpoint-commit" }),
  ),
  edge(
    60,
    ["reviewed"],
    workflowEdge(
      "checkpoint.acceptance",
      "checkpoint-commit",
      "bind-acceptance",
      "acceptance-binding-required",
      {
        requiredEvidenceKinds: ["candidate-commit"],
        checkpointPolicy: "clean-candidate-commit-required",
      },
    ),
    (snapshot) => snapshot.acceptance === "missing",
    staticAction({ kind: "bind-acceptance" }),
  ),
  edge(
    70,
    ["solo", "assisted"],
    workflowEdge("checkpoint.verify", "checkpoint-commit", "verify", "verification-required", {
      requiredEvidenceKinds: ["candidate-commit"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.acceptance === "not-required" && snapshot.verification === "missing",
    staticAction({ kind: "verify" }),
  ),
  edge(
    70,
    ["reviewed"],
    workflowEdge("acceptance.verify", "bind-acceptance", "verify", "verification-required", {
      requiredEvidenceKinds: ["acceptance-binding"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.acceptance === "satisfied" && snapshot.verification === "missing",
    staticAction({ kind: "verify" }),
  ),
  edge(
    90,
    everyTemplate,
    workflowEdge("verify.repair", "verify", "repair", "verification-failed-repairable", {
      kind: "back",
      budgetId: "repair",
      requiredEvidenceKinds: ["verification-failure"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.verification === "failed",
    repairAction,
    nextRepairOrdinal,
  ),
  edge(
    100,
    ["reviewed"],
    workflowEdge("verify.review", "verify", "review", "review-required", {
      requiredEvidenceKinds: ["verification"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.review === "missing",
    staticAction({ kind: "review" }),
  ),
  edge(
    120,
    ["reviewed"],
    workflowEdge("review.repair", "review", "repair", "review-blocking-repairable", {
      kind: "back",
      budgetId: "repair",
      requiredEvidenceKinds: ["review-findings"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.review === "blocking",
    repairAction,
    nextRepairOrdinal,
  ),
  edge(
    140,
    ["solo", "assisted"],
    workflowEdge("verify.ready", "verify", "ready", "ready-evidence-satisfied", {
      requiredEvidenceKinds: ["verification"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.review !== "passed" && readyEvidenceSatisfied(snapshot),
    staticAction({ kind: "advance-ready" }),
  ),
  edge(
    140,
    ["reviewed"],
    workflowEdge("review.ready", "review", "ready", "ready-evidence-satisfied", {
      requiredEvidenceKinds: ["verification", "review"],
      checkpointPolicy: "clean-candidate-commit-required",
    }),
    (snapshot) => snapshot.review === "passed" && readyEvidenceSatisfied(snapshot),
    staticAction({ kind: "advance-ready" }),
  ),
];

const blockRules: readonly WorkflowBlockRule[] = [
  block(20, "Explorer failed", (snapshot) => snapshot.exploration === "failed"),
  block(21, "Writer failed", (snapshot) => snapshot.writer === "failed"),
  block(
    55,
    "Running repair has no durable pending transition provenance",
    (snapshot) =>
      snapshot.writer === "running" &&
      snapshot.repairsUsed > 0 &&
      snapshot.verification !== "failed" &&
      snapshot.review !== "blocking",
  ),
  block(
    80,
    "Verification failed: repeated failure signature",
    (snapshot) =>
      snapshot.verification === "failed" &&
      snapshot.writer !== "running" &&
      snapshot.repeatedFailure,
  ),
  block(
    81,
    "Verification failed: repair budget exhausted",
    (snapshot) =>
      snapshot.verification === "failed" &&
      snapshot.writer !== "running" &&
      snapshot.repairsUsed >= snapshot.maximumRepairs,
  ),
  block(
    110,
    "Review has blocking findings: repeated failure signature",
    (snapshot) =>
      snapshot.review === "blocking" &&
      snapshot.writer !== "running" &&
      snapshot.repeatedFailure,
  ),
  block(
    111,
    "Review has blocking findings: repair budget exhausted",
    (snapshot) =>
      snapshot.review === "blocking" &&
      snapshot.writer !== "running" &&
      snapshot.repairsUsed >= snapshot.maximumRepairs,
  ),
  block(130, "Independent review is unavailable", (snapshot) => snapshot.review === "unavailable"),
  block(150, "Required Evidence is incomplete", (snapshot) => !readyEvidenceSatisfied(snapshot)),
  block(
    160,
    "No registered workflow transition matches the proof state",
    (snapshot) => readyEvidenceSatisfied(snapshot),
  ),
];

for (const rule of edgeRules) {
  Object.freeze(rule.templates);
  Object.freeze(rule.edge.requiredEvidenceKinds);
  Object.freeze(rule.edge);
  Object.freeze(rule);
}
for (const rule of blockRules) Object.freeze(rule);
Object.freeze(edgeRules);
Object.freeze(blockRules);

export const workflowPolicyRegistry: readonly WorkflowPolicyRule[] = Object.freeze([
  ...edgeRules,
  ...blockRules,
].sort((left, right) => left.decisionOrder - right.decisionOrder));

export const workflowTransitionRegistry: readonly WorkflowEdgeRule[] = edgeRules;

export function workflowEdgesForTemplate(template: ExecutionTemplateName): readonly WorkflowEdge[] {
  return edgeRules
    .filter((rule) => rule.templates.includes(template))
    .map((rule) => cloneEdge(rule.edge));
}

export function workflowTransitionForEdge(edgeId: string): WorkflowEdgeRule | null {
  return edgeRules.find((rule) => rule.edge.id === edgeId) ?? null;
}

export function isRegisteredWorkflowBackEdge(edge: WorkflowEdge): boolean {
  const rule = workflowTransitionForEdge(edge.id);
  return rule !== null &&
    rule.edge.kind === "back" &&
    rule.edge.from === edge.from &&
    rule.edge.to === edge.to;
}

export function workflowActionForTransitionReceipt(
  edgeId: string,
  budgetOrdinal: number | null,
): NextAction | null {
  return workflowTransitionForEdge(edgeId)?.actionForReceipt(budgetOrdinal) ?? null;
}

export function evaluateWorkflowTransitionProof(
  candidate: WorkflowEdge,
  snapshot: ProofGapSnapshot,
): WorkflowTransitionProof {
  const rule = workflowTransitionForEdge(candidate.id);
  const registered = rule !== null &&
    rule.templates.includes(snapshot.template) &&
    workflowEdgeMetadataEqual(rule.edge, candidate);
  const unknownRequirements = candidate.requiredEvidenceKinds.filter(
    (requirement) => !workflowEvidenceRequirementSet.has(requirement),
  );
  const guardSatisfied = registered && rule.matches(snapshot);
  const requirementsSatisfied = unknownRequirements.length === 0 &&
    candidate.requiredEvidenceKinds.every((requirement) =>
      workflowEvidenceRequirementSatisfied(requirement, snapshot)
    );
  const checkpointSatisfied = workflowCheckpointSatisfied(candidate, snapshot);
  return {
    registered,
    guardSatisfied,
    requirementsSatisfied,
    checkpointSatisfied,
    satisfied: registered && guardSatisfied && requirementsSatisfied && checkpointSatisfied,
    unknownRequirements,
  };
}

export function decideWorkflowPolicyTransition(
  snapshot: ProofGapSnapshot,
  manifest?: WorkflowTopologyManifest,
): WorkflowDecision {
  if (manifest && manifest.template !== snapshot.template) {
    return blocked(
      `Frozen workflow template ${manifest.template} does not match proof template ${snapshot.template}`,
    );
  }
  for (const rule of workflowPolicyRegistry) {
    if (rule.ruleKind === "edge" && !rule.templates.includes(snapshot.template)) continue;
    if (!rule.matches(snapshot)) continue;
    if (rule.ruleKind === "block") return blocked(rule.reason);

    const candidate = manifest
      ? manifest.edges.find((item) => item.id === rule.edge.id)
      : rule.edge;
    if (!candidate) {
      return blocked(`Required transition ${rule.edge.id} is not allowed by the frozen topology`);
    }
    const proof = evaluateWorkflowTransitionProof(candidate, snapshot);
    if (!proof.satisfied) {
      return blocked(`Required transition ${rule.edge.id} is inconsistent with its frozen proof policy`);
    }
    const action = rule.actionForReceipt(rule.budgetOrdinal(snapshot));
    if (action === null) {
      return blocked(`Required transition ${rule.edge.id} has an invalid budget receipt`);
    }
    return { edgeId: candidate.id, guard: candidate.guard, action };
  }
  return blocked("No registered workflow transition matches the proof state");
}

function workflowEvidenceRequirementSatisfied(
  requirement: string,
  snapshot: ProofGapSnapshot,
): boolean {
  return isWorkflowEvidenceRequirement(requirement) &&
    workflowEvidenceRequirementEvaluators[requirement](snapshot);
}

function workflowCheckpointSatisfied(
  candidate: WorkflowEdge,
  snapshot: ProofGapSnapshot,
): boolean {
  if (candidate.checkpointPolicy === "none") return true;
  if (candidate.checkpointPolicy !== "clean-candidate-commit-required") return false;
  if (snapshot.writer === "committed") return true;
  // A running repair with consumed budget is an interrupted execution of an
  // already-admitted back edge. New executions reach this edge from a clean,
  // current candidate commit; the durable budget receipt preserves that fact.
  return candidate.kind === "back" && snapshot.writer === "running" && snapshot.repairsUsed > 0;
}

export function workflowEdgeMetadataEqual(left: WorkflowEdge, right: WorkflowEdge): boolean {
  return left.id === right.id &&
    left.from === right.from &&
    left.to === right.to &&
    left.kind === right.kind &&
    left.guard === right.guard &&
    left.budgetId === right.budgetId &&
    left.checkpointPolicy === right.checkpointPolicy &&
    left.requiredEvidenceKinds.length === right.requiredEvidenceKinds.length &&
    left.requiredEvidenceKinds.every((item, index) => item === right.requiredEvidenceKinds[index]);
}

function cloneEdge(value: WorkflowEdge): WorkflowEdge {
  return { ...value, requiredEvidenceKinds: [...value.requiredEvidenceKinds] };
}

function blocked(reason: string): WorkflowDecision {
  return { edgeId: null, guard: null, action: { kind: "block", reason } };
}
