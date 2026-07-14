import { describe, expect, it } from "vitest";
import { decideNextAction, type ProofGapSnapshot } from "../src/loop.js";

const base: ProofGapSnapshot = {
  risk: "low",
  template: "solo",
  exploration: "not-required",
  writer: "missing",
  verification: "missing",
  review: "not-required",
  repairsUsed: 0,
  maximumRepairs: 1,
  repeatedFailure: false,
};

describe("bounded proof-gap decision", () => {
  it("selects one minimum action without adding a workflow graph", () => {
    expect(decideNextAction(base)).toEqual({ kind: "author", attempt: 1 });
    expect(decideNextAction({ ...base, writer: "patch-ready" })).toEqual({ kind: "checkpoint-commit" });
    expect(decideNextAction({ ...base, writer: "committed" })).toEqual({ kind: "verify" });
    expect(decideNextAction({ ...base, writer: "committed", verification: "passed" })).toEqual({ kind: "advance-ready" });
  });

  it("turns ordinary verification feedback into one same-Run repair", () => {
    expect(decideNextAction({
      ...base, writer: "committed", verification: "failed",
    })).toEqual({ kind: "repair", attempt: 1 });
    expect(decideNextAction({
      ...base, writer: "committed", verification: "failed", repairsUsed: 1,
    })).toEqual({ kind: "block", reason: "Verification failed: repair budget exhausted" });
    expect(decideNextAction({
      ...base, writer: "committed", verification: "failed", repeatedFailure: true,
    })).toEqual({ kind: "block", reason: "Verification failed: repeated failure signature" });
  });

  it("re-enters the same persisted Writer attempt after an interruption", () => {
    expect(decideNextAction({ ...base, writer: "running" })).toEqual({ kind: "author", attempt: 1 });
    expect(decideNextAction({
      ...base,
      writer: "running",
      verification: "failed",
      repairsUsed: 1,
    })).toEqual({ kind: "repair", attempt: 1 });
  });

  it("requires human risk classification and a reviewed proof when applicable", () => {
    expect(decideNextAction({ ...base, risk: "unknown" })).toEqual({ kind: "resolve-risk" });
    expect(decideNextAction({
      ...base, risk: "high", template: "reviewed", writer: "committed", verification: "passed", review: "missing",
    })).toEqual({ kind: "review" });
  });
});
