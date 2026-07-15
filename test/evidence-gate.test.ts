import { describe, expect, it } from "vitest";
import type { Evidence } from "../src/domain.js";
import { EvidenceGate, readyEvidenceSatisfied } from "../src/evidence-gate.js";
import type { ProofGapSnapshot } from "../src/loop.js";

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    id: "E-1",
    runId: "run-1",
    operationId: null,
    kind: "command",
    status: "valid",
    commitSha: "commit-1",
    policyVersion: "policy/v1",
    stepId: "verify:test",
    dependencyHash: "required-hash",
    dependencyVersion: null,
    dependencies: null,
    data: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    invalidatedAt: null,
    ...overrides,
  };
}

const readySnapshot: ProofGapSnapshot = {
  risk: "high",
  template: "reviewed",
  exploration: "not-required",
  writer: "committed",
  acceptance: "satisfied",
  verification: "passed",
  review: "passed",
  repairsUsed: 0,
  maximumRepairs: 1,
  repeatedFailure: false,
};

describe("EvidenceGate", () => {
  it("ignores invalid Evidence when satisfying required dependency hashes", () => {
    const gate = new EvidenceGate([
      evidence({ status: "invalid", dependencyHash: "invalid-only" }),
      evidence({ dependencyHash: "required-hash" }),
    ]);

    expect(gate.verificationStatus("commit-1", ["required-hash"])).toBe("passed");
    expect(gate.verificationStatus("commit-1", ["invalid-only"])).toBe("missing");
  });

  it("lets a current failure Evidence override passing command Evidence", () => {
    const gate = new EvidenceGate([
      evidence({ dependencyHash: "required-hash" }),
      evidence({ id: "E-FAIL", kind: "verification_failure", stepId: "verification-failure:test" }),
    ]);

    expect(gate.verificationStatus("commit-1", ["required-hash"])).toBe("failed");
  });

  it("advances ready only when every required proof is satisfied", () => {
    expect(readyEvidenceSatisfied(readySnapshot)).toBe(true);
    expect(readyEvidenceSatisfied({ ...readySnapshot, review: "missing" })).toBe(false);
    expect(readyEvidenceSatisfied({ ...readySnapshot, acceptance: "missing" })).toBe(false);
  });
});
