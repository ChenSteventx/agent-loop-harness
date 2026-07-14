import { describe, expect, it } from "vitest";
import { executionTemplates, routeRisk } from "../src/routing.js";
import { assertCoreMayCreateAgent } from "../src/roles.js";
import { hashReviewDiff, invalidateStaleReview, type ReviewerResult } from "../src/reviewer.js";
import { createProviderProfile } from "../src/profiles.js";
import { SqliteStore } from "../src/store.js";
import type { ProviderAdapter } from "../src/provider.js";

describe("Phase 2 integration gate", () => {
  it("keeps all routing fixed and non-recursive", () => {
    expect([routeRisk("low"), routeRisk("normal"), routeRisk("high")]).toEqual(["solo", "assisted", "reviewed"]);
    expect(Object.keys(executionTemplates)).toEqual(["solo", "assisted", "reviewed"]);
    expect(() => assertCoreMayCreateAgent("author")).toThrow("cannot create a child Agent");
    expect(() => assertCoreMayCreateAgent("explorer")).toThrow("cannot create a child Agent");
    expect(() => assertCoreMayCreateAgent("reviewer")).toThrow("cannot create a child Agent");
    expect(assertCoreMayCreateAgent("core")).toBeUndefined();
  });

  it("invalidates review evidence when only the reviewed diff changes", () => {
    const diff = "diff --git a/a b/a\n+x\n";
    const result = { report: { findings: [] }, provider: {}, reviewedCommit: "abc", diffHash: hashReviewDiff(diff), stale: false } as unknown as ReviewerResult;
    expect(invalidateStaleReview(result, { commit: "abc", diffHash: hashReviewDiff(`${diff}+y\n`) })).toMatchObject({ stale: true, report: null });
  });

  it("uses the same fixed Core lifecycle for both primary profiles", () => {
    const adapter = {} as ProviderAdapter;
    const providers = { codex: { adapter, family: "codex" as const, name: "Codex" }, claude: { adapter, family: "claude" as const, name: "Claude" }, deepseek: { adapter, family: "deepseek" as const, name: "DeepSeek" } };
    for (const name of ["CODEX_PRIMARY", "CLAUDE_PRIMARY"] as const) {
      const profile = createProviderProfile(name, providers);
      expect(profile.author.adapter).toBe(adapter);
      expect(executionTemplates.reviewed.steps).toEqual(["author", "verification", "independent-review", "repair", "verification"]);
    }
  });

  it("persists available Agent usage and finding quality metrics", () => {
    const store = new SqliteStore(":memory:");
    store.createRun("run", "task");
    store.recordAgentCall("run", { role: "explorer", provider: "codex", latencyMs: 12, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 } });
    store.recordAgentCall("run", { role: "reviewer", provider: "claude", latencyMs: 8, usage: null });
    store.recordFindingOutcome("run", "F1", "confirmed");
    store.recordFindingOutcome("run", "F2", "false_positive");
    expect(store.getRunMetrics("run")).toEqual({ agentCalls: 2, latencyMs: 20, inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, confirmedFindings: 1, falsePositives: 1 });
    store.close();
  });
});
