import type { Evidence } from "./domain.js";
import type { ProofGapSnapshot, VerificationProof } from "./loop.js";

export class EvidenceGate {
  private readonly valid: readonly Evidence[];

  constructor(evidence: readonly Evidence[]) {
    this.valid = evidence.filter((item) => item.status === "valid");
  }

  validEvidence(): readonly Evidence[] {
    return this.valid;
  }

  has(kind: string, predicate: (evidence: Evidence) => boolean): boolean {
    return this.matching(kind, predicate).length > 0;
  }

  matching(kind: string, predicate: (evidence: Evidence) => boolean): readonly Evidence[] {
    return this.valid.filter((item) => item.kind === kind && predicate(item));
  }

  verificationStatus(currentCommit: string, requiredDependencyHashes: readonly string[]): VerificationProof {
    if (this.has("verification_failure", (item) => item.commitSha === currentCommit)) return "failed";
    const validHashes = new Set(this.valid.map((item) => item.dependencyHash));
    return requiredDependencyHashes.length > 0 && requiredDependencyHashes.every((hash) => validHashes.has(hash))
      ? "passed"
      : "missing";
  }
}

export function readyEvidenceSatisfied(snapshot: ProofGapSnapshot): boolean {
  return snapshot.risk !== "unknown" &&
    (snapshot.exploration === "not-required" || snapshot.exploration === "satisfied") &&
    snapshot.writer === "committed" &&
    (snapshot.acceptance === "not-required" || snapshot.acceptance === "satisfied") &&
    snapshot.verification === "passed" &&
    (snapshot.review === "not-required" || snapshot.review === "passed");
}
