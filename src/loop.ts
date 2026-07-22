import type { ExecutionTemplateName, Risk } from "./routing.js";
import { readyEvidenceSatisfied } from "./evidence-gate.js";
import type { WorkflowGuardId } from "./workflow-topology.js";

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

export function decideNextTransition(snapshot: ProofGapSnapshot): WorkflowDecision {
  if (snapshot.risk === "unknown") {
    return transition("entry.resolve-risk", "risk-unknown", { kind: "resolve-risk" });
  }
  if (snapshot.exploration === "failed") return blocked("Explorer failed");
  if (snapshot.writer === "failed") return blocked("Writer failed");
  if (snapshot.exploration === "missing") {
    return transition("entry.explore", "exploration-required", { kind: "explore" });
  }
  if (snapshot.writer === "missing") return authorTransition(snapshot);
  if (snapshot.writer === "patch-ready") {
    return transition(
      snapshot.repairsUsed > 0 ? "repair.checkpoint" : "author.checkpoint",
      "writer-patch-ready",
      { kind: "checkpoint-commit" },
    );
  }
  if (snapshot.writer === "running") {
    if (snapshot.repairsUsed === 0) return authorTransition(snapshot);
    return resumedRepairTransition(snapshot);
  }
  if (snapshot.acceptance === "missing") {
    return transition(
      "checkpoint.acceptance",
      "acceptance-binding-required",
      { kind: "bind-acceptance" },
    );
  }
  if (snapshot.verification === "missing") {
    return transition(
      snapshot.acceptance === "not-required" ? "checkpoint.verify" : "acceptance.verify",
      "verification-required",
      { kind: "verify" },
    );
  }
  if (snapshot.verification === "failed") {
    return repairOrBlock(
      snapshot,
      "Verification failed",
      "verify.repair",
      "verification-failed-repairable",
    );
  }
  if (snapshot.review === "missing") {
    return transition("verify.review", "review-required", { kind: "review" });
  }
  if (snapshot.review === "blocking") {
    return repairOrBlock(
      snapshot,
      "Review has blocking findings",
      "review.repair",
      "review-blocking-repairable",
    );
  }
  if (snapshot.review === "unavailable") {
    return blocked("Independent review is unavailable");
  }
  if (!readyEvidenceSatisfied(snapshot)) return blocked("Required Evidence is incomplete");
  return transition(
    snapshot.review === "passed" ? "review.ready" : "verify.ready",
    "ready-evidence-satisfied",
    { kind: "advance-ready" },
  );
}

export function decideNextAction(snapshot: ProofGapSnapshot): NextAction {
  return decideNextTransition(snapshot).action;
}

export function workflowActionForEdge(edgeId: string, budgetOrdinal: number | null): NextAction | null {
  if (edgeId === "entry.resolve-risk") return { kind: "resolve-risk" };
  if (edgeId === "entry.explore") return { kind: "explore" };
  if (edgeId === "entry.author" || edgeId === "explore.author") return { kind: "author", attempt: 1 };
  if (edgeId === "author.checkpoint" || edgeId === "repair.checkpoint") return { kind: "checkpoint-commit" };
  if (edgeId === "checkpoint.acceptance") return { kind: "bind-acceptance" };
  if (edgeId === "checkpoint.verify" || edgeId === "acceptance.verify") return { kind: "verify" };
  if (edgeId === "verify.review") return { kind: "review" };
  if (edgeId === "verify.ready" || edgeId === "review.ready") return { kind: "advance-ready" };
  if (edgeId === "verify.repair" || edgeId === "review.repair") {
    return budgetOrdinal === null ? null : { kind: "repair", attempt: budgetOrdinal };
  }
  return null;
}

function authorTransition(snapshot: ProofGapSnapshot): WorkflowDecision {
  return transition(
    snapshot.exploration === "satisfied" ? "explore.author" : "entry.author",
    "writer-required",
    { kind: "author", attempt: 1 },
  );
}

function resumedRepairTransition(snapshot: ProofGapSnapshot): WorkflowDecision {
  if (snapshot.verification === "failed") {
    return transition(
      "verify.repair",
      "verification-failed-repairable",
      { kind: "repair", attempt: snapshot.repairsUsed },
    );
  }
  if (snapshot.review === "blocking") {
    return transition(
      "review.repair",
      "review-blocking-repairable",
      { kind: "repair", attempt: snapshot.repairsUsed },
    );
  }
  return {
    edgeId: null,
    guard: null,
    action: { kind: "repair", attempt: snapshot.repairsUsed },
  };
}

function repairOrBlock(
  snapshot: ProofGapSnapshot,
  reason: string,
  edgeId: string,
  guard: WorkflowGuardId,
): WorkflowDecision {
  if (snapshot.repeatedFailure) return blocked(`${reason}: repeated failure signature`);
  if (snapshot.repairsUsed >= snapshot.maximumRepairs) {
    return blocked(`${reason}: repair budget exhausted`);
  }
  return transition(edgeId, guard, { kind: "repair", attempt: snapshot.repairsUsed + 1 });
}

function transition(edgeId: string, guard: WorkflowGuardId, action: NextAction): WorkflowDecision {
  return { edgeId, guard, action };
}

function blocked(reason: string): WorkflowDecision {
  return { edgeId: null, guard: null, action: { kind: "block", reason } };
}
