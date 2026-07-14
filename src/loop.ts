import type { ExecutionTemplateName, Risk } from "./routing.js";

export type ExplorationProof = "not-required" | "missing" | "satisfied" | "failed";
export type WriterProof = "missing" | "running" | "patch-ready" | "failed" | "committed";
export type VerificationProof = "missing" | "passed" | "failed";
export type ReviewProof = "not-required" | "missing" | "passed" | "blocking" | "unavailable";

export interface ProofGapSnapshot {
  risk: Risk;
  template: ExecutionTemplateName;
  exploration: ExplorationProof;
  writer: WriterProof;
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
  | { kind: "verify" }
  | { kind: "review" }
  | { kind: "repair"; attempt: number }
  | { kind: "advance-ready" }
  | { kind: "block"; reason: string };

export function decideNextAction(snapshot: ProofGapSnapshot): NextAction {
  if (snapshot.risk === "unknown") return { kind: "resolve-risk" };
  if (snapshot.exploration === "failed") return { kind: "block", reason: "Explorer failed" };
  if (snapshot.writer === "failed") return { kind: "block", reason: "Writer failed" };
  if (snapshot.exploration === "missing") return { kind: "explore" };
  if (snapshot.writer === "missing") return { kind: "author", attempt: 1 };
  if (snapshot.writer === "patch-ready") return { kind: "checkpoint-commit" };
  if (snapshot.writer === "running") {
    return snapshot.repairsUsed > 0
      ? { kind: "repair", attempt: snapshot.repairsUsed }
      : { kind: "author", attempt: 1 };
  }
  if (snapshot.verification === "missing") return { kind: "verify" };
  if (snapshot.verification === "failed") return repairOrBlock(snapshot, "Verification failed");
  if (snapshot.review === "missing") return { kind: "review" };
  if (snapshot.review === "blocking") return repairOrBlock(snapshot, "Review has blocking findings");
  if (snapshot.review === "unavailable") {
    return { kind: "block", reason: "Independent review is unavailable" };
  }
  return { kind: "advance-ready" };
}

function repairOrBlock(snapshot: ProofGapSnapshot, reason: string): NextAction {
  if (snapshot.repeatedFailure) return { kind: "block", reason: `${reason}: repeated failure signature` };
  if (snapshot.repairsUsed >= snapshot.maximumRepairs) {
    return { kind: "block", reason: `${reason}: repair budget exhausted` };
  }
  return { kind: "repair", attempt: snapshot.repairsUsed + 1 };
}
