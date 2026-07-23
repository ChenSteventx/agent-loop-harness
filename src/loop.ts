import type { ExecutionTemplateName, Risk } from "./routing.js";
import {
  decideWorkflowPolicyTransition,
  workflowActionForTransitionReceipt,
} from "./workflow-transition-registry.js";
import type { WorkflowGuardId, WorkflowTopologyManifest } from "./workflow-topology.js";

export type ExplorationProof = "not-required" | "missing" | "satisfied" | "failed";
export type WriterProof = "missing" | "running" | "patch-ready" | "failed" | "committed";
export type VerificationProof = "missing" | "passed" | "failed";
export type AcceptanceProof = "not-required" | "missing" | "satisfied";
export type ReviewProof = "not-required" | "missing" | "passed" | "blocking" | "unavailable";

export interface ProofGapSnapshot {
  risk: Risk;
  template: ExecutionTemplateName;
  exploration: ExplorationProof;
  writer: WriterProof;
  acceptance: AcceptanceProof;
  verification: VerificationProof;
  review: ReviewProof;
  repairsUsed: number;
  maximumRepairs: number;
  repeatedFailure: boolean;
}

export type NextAction =
  | { kind: "resolve-risk" }
  | { kind: "explore" }
  | { kind: "author"; attempt: 1 }
  | { kind: "checkpoint-commit" }
  | { kind: "bind-acceptance" }
  | { kind: "verify" }
  | { kind: "review" }
  | { kind: "repair"; attempt: number }
  | { kind: "advance-ready" }
  | { kind: "block"; reason: string };

export interface WorkflowDecision {
  action: NextAction;
  edgeId: string | null;
  guard: WorkflowGuardId | null;
}

export function decideNextTransition(
  snapshot: ProofGapSnapshot,
  manifest?: WorkflowTopologyManifest,
): WorkflowDecision {
  return decideWorkflowPolicyTransition(snapshot, manifest);
}

export function decideNextAction(snapshot: ProofGapSnapshot): NextAction {
  return decideNextTransition(snapshot).action;
}

export function workflowActionForEdge(edgeId: string, budgetOrdinal: number | null): NextAction | null {
  return workflowActionForTransitionReceipt(edgeId, budgetOrdinal);
}
