import { describe, expect, it } from "vitest";
import { conflictResolution, hashReviewDiff, invalidateStaleReview, isBlockingFinding, runReviewedRepair, runReviewer, type Finding } from "../src/reviewer.js";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../src/provider.js";

const identity = { provider: "fake", model: "reviewer", executable: "fake", version: "1" };
const diff = "diff --git a/a b/a\n+fixed\n";
const commit = "abc123";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1", category: "correctness", severity: "high", claim: "behavior is wrong", location: "src/a.ts:1",
    verificationRequest: { verificationStepId: "test", proposedArgv: ["npm", "test"], expectedExitCode: 1, stderrIncludes: "failed" },
    evidenceIds: [], confidence: 0.9,
    proposedVerification: "run npm test", reviewerIdentity: identity, reviewedCommit: commit, status: "proposed", ...overrides,
  };
}

class FakeReviewer implements ProviderAdapter {
  request: ProviderRunRequest | null = null;
  mutate?: () => void;
  async probe() { return { available: true, identity, error: null }; }
  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.request = request;
    this.mutate?.();
    return { invocationId: request.invocationId, ok: true, cancelled: false, identity, threadId: "t", events: [],
      finalOutput: {
        findings: [{
          id: "F1", category: "correctness", severity: "high", claim: "behavior is wrong", location: "src/a.ts:1",
          verificationRequest: { verificationStepId: "test", proposedArgv: ["npm", "test"], expectedExitCode: 1, stderrIncludes: "failed" },
          evidenceIds: [], confidence: 0.9,
          proposedVerification: "run npm test", status: "proposed",
        }],
      }, stderr: "", exitCode: 0, signal: null, durationMs: 1, usage: null,
      failureClass: null, eventsPath: "events", finalOutputPath: "final", stderrPath: "stderr" };
  }
  async cancel() { return false; }
}

function input() {
  return { task: { id: "T", goal: "fix", acceptance: ["works"], risk: "high" as const, verification: [{ id: "test", argv: ["npm", "test"] as [string, ...string[]] }] },
    diff, reviewedCommit: commit, diffHash: hashReviewDiff(diff), verificationEvidence: [{ evidenceId: "E1", command: ["npm", "test"], exitCode: 0, commitSha: commit, result: "passed" }],
    allowedRepositoryRoots: ["/repo"], contextBudget: 100, controlStateHash: "control-1" };
}

describe("independent reviewer", () => {
  it("is read-only, fixed to commit and diff, and excludes Author self-evaluation from first-pass context", async () => {
    const provider = new FakeReviewer();
    const state = { commit, diffHash: hashReviewDiff(diff), dirty: false, controlStateHash: "control-1" };
    const result = await runReviewer(provider, input(), () => state, { invocationId: "review", cwd: "/repo", artifactDirectory: "/artifacts", outputSchemaPath: "/schema" });
    expect(provider.request).toMatchObject({ workspaceAccess: "read-only", allowedRepositoryRoots: ["/repo"], contextBudget: 100 });
    expect(provider.request?.additionalWritableDirectories).toBeUndefined();
    expect(provider.request?.prompt).toContain("Verification evidence:");
    expect(provider.request?.prompt).not.toMatch(/self[- ]evaluation/i);
    expect(result.report?.findings[0]).toEqual(finding());
    expect(provider.request?.prompt).toContain("Harness binds those facts");
  });

  it("rejects provider attempts to self-assert identity or reviewed commit", async () => {
    const provider = new FakeReviewer();
    const original = provider.run.bind(provider);
    provider.run = async (request) => {
      const result = await original(request);
      const first = (result.finalOutput as { findings: Record<string, unknown>[] }).findings[0]!;
      return { ...result, finalOutput: { findings: [{ ...first, reviewerIdentity: identity, reviewedCommit: "forged" }] } };
    };
    const state = { commit, diffHash: hashReviewDiff(diff), dirty: false, controlStateHash: "control-1" };
    expect((await runReviewer(provider, input(), () => state, {
      invocationId: "forged", cwd: "/repo", artifactDirectory: "/artifacts", outputSchemaPath: "/schema",
    })).report).toBeNull();
  });

  it("rejects reviewer writes and invalidates review evidence when the commit changes", async () => {
    const provider = new FakeReviewer();
    const state = { commit, diffHash: hashReviewDiff(diff), dirty: false, controlStateHash: "control-1" };
    provider.mutate = () => { state.dirty = true; };
    await expect(runReviewer(provider, input(), () => state, { invocationId: "review", cwd: "/repo", artifactDirectory: "/a", outputSchemaPath: "/s" })).rejects.toThrow("read-only");
    state.dirty = false;
    const clean = await runReviewer(new FakeReviewer(), input(), () => state, { invocationId: "review2", cwd: "/repo", artifactDirectory: "/a", outputSchemaPath: "/s" });
    expect(invalidateStaleReview(clean, { commit: "new", diffHash: state.diffHash })).toMatchObject({ stale: true, report: null });
  });

  it("requires a Harness-confirmed lifecycle state before a finding can block", () => {
    const unsupported = finding({ verificationRequest: null });
    expect(isBlockingFinding(unsupported)).toBe(false);
    expect(isBlockingFinding(finding())).toBe(false);
    expect(isBlockingFinding(finding({ status: "confirmed" }))).toBe(true);
    expect(conflictResolution(unsupported)).toBe("evidence_request");
    expect(conflictResolution(finding())).toBe("deterministic_experiment");
  });

  it("allows no more than one automatic repair", async () => {
    let repairs = 0;
    const result = await runReviewedRepair(0, async () => ++repairs, async (value) => value === 1);
    expect(result).toEqual({ value: 1, repairs: 1, verified: true });
    expect(repairs).toBe(1);
  });
});
