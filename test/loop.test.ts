import { describe, expect, it } from "vitest";
import {
  decideNextAction,
  decideNextTransition,
  type ProofGapSnapshot,
} from "../src/loop.js";

const base: ProofGapSnapshot = {
  risk: "low",
  template: "solo",
  exploration: "not-required",
  writer: "missing",
  acceptance: "not-required",
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
      ...base, risk: "high", template: "reviewed", writer: "committed", acceptance: "satisfied", verification: "passed", review: "missing",
    })).toEqual({ kind: "review" });
    expect(decideNextAction({
      ...base, risk: "high", template: "reviewed", writer: "committed", acceptance: "missing",
    })).toEqual({ kind: "bind-acceptance" });
  });

  it.each([
    [{ ...base, risk: "unknown" }, "entry.resolve-risk", "risk-unknown", { kind: "resolve-risk" }],
    [{ ...base, exploration: "missing" }, "entry.explore", "exploration-required", { kind: "explore" }],
    [{ ...base, exploration: "satisfied" }, "explore.author", "writer-required", { kind: "author", attempt: 1 }],
    [base, "entry.author", "writer-required", { kind: "author", attempt: 1 }],
    [{ ...base, writer: "patch-ready" }, "author.checkpoint", "writer-patch-ready", { kind: "checkpoint-commit" }],
    [{ ...base, writer: "patch-ready", repairsUsed: 1 }, "repair.checkpoint", "writer-patch-ready", { kind: "checkpoint-commit" }],
    [{ ...base, writer: "committed", acceptance: "missing" }, "checkpoint.acceptance", "acceptance-binding-required", { kind: "bind-acceptance" }],
    [{ ...base, writer: "committed" }, "checkpoint.verify", "verification-required", { kind: "verify" }],
    [{ ...base, writer: "committed", acceptance: "satisfied" }, "acceptance.verify", "verification-required", { kind: "verify" }],
    [{ ...base, writer: "committed", verification: "failed" }, "verify.repair", "verification-failed-repairable", { kind: "repair", attempt: 1 }],
    [{ ...base, writer: "committed", verification: "passed", review: "missing" }, "verify.review", "review-required", { kind: "review" }],
    [{ ...base, writer: "committed", verification: "passed", review: "blocking" }, "review.repair", "review-blocking-repairable", { kind: "repair", attempt: 1 }],
    [{ ...base, writer: "committed", verification: "passed" }, "verify.ready", "ready-evidence-satisfied", { kind: "advance-ready" }],
    [{ ...base, writer: "committed", verification: "passed", review: "passed" }, "review.ready", "ready-evidence-satisfied", { kind: "advance-ready" }],
  ] as const)("binds a deterministic transition to an allowed edge", (snapshot, edgeId, guard, action) => {
    expect(decideNextTransition(snapshot)).toEqual({ edgeId, guard, action });
  });

  it.each([
    [{ ...base, exploration: "failed" }, "Explorer failed"],
    [{ ...base, writer: "failed" }, "Writer failed"],
    [{ ...base, writer: "committed", verification: "failed", repeatedFailure: true }, "Verification failed: repeated failure signature"],
    [{ ...base, writer: "committed", verification: "failed", repairsUsed: 1 }, "Verification failed: repair budget exhausted"],
    [{ ...base, writer: "committed", verification: "passed", review: "blocking", repeatedFailure: true }, "Review has blocking findings: repeated failure signature"],
    [{ ...base, writer: "committed", verification: "passed", review: "blocking", repairsUsed: 1 }, "Review has blocking findings: repair budget exhausted"],
    [{ ...base, writer: "committed", verification: "passed", review: "unavailable" }, "Independent review is unavailable"],
  ] as const)("does not claim a topology edge for a terminal block", (snapshot, reason) => {
    expect(decideNextTransition(snapshot)).toEqual({
      edgeId: null,
      guard: null,
      action: { kind: "block", reason },
    });
  });

  it("preserves the original edge identity while resuming running author and repair work", () => {
    expect(decideNextTransition({ ...base, exploration: "satisfied", writer: "running" })).toEqual({
      edgeId: "explore.author",
      guard: "writer-required",
      action: { kind: "author", attempt: 1 },
    });
    expect(decideNextTransition({ ...base, writer: "running", verification: "failed", repairsUsed: 1 })).toEqual({
      edgeId: "verify.repair",
      guard: "verification-failed-repairable",
      action: { kind: "repair", attempt: 1 },
    });
    expect(decideNextTransition({
      ...base,
      writer: "running",
      verification: "passed",
      review: "blocking",
      repairsUsed: 1,
    })).toEqual({
      edgeId: "review.repair",
      guard: "review-blocking-repairable",
      action: { kind: "repair", attempt: 1 },
    });
  });

  it("keeps decideNextAction as an exact compatibility wrapper", () => {
    const snapshots: ProofGapSnapshot[] = [
      base,
      { ...base, writer: "patch-ready" },
      { ...base, writer: "committed", verification: "failed" },
      { ...base, writer: "committed", verification: "passed" },
    ];
    for (const snapshot of snapshots) {
      expect(decideNextAction(snapshot)).toEqual(decideNextTransition(snapshot).action);
    }
  });
});
