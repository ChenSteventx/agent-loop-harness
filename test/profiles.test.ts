import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/provider.js";
import { createProviderProfile, independentReviewCandidates, isIndependentReceipt, selectReviewer, withFallbackOutbox, workspaceRoleCandidates } from "../src/profiles.js";
import { SqliteStore } from "../src/store.js";

const providers = {
  codex: { adapter: {} as ProviderAdapter, family: "codex" as const, name: "Codex" },
  claude: { adapter: {} as ProviderAdapter, family: "claude" as const, name: "Claude" },
  deepseek: { adapter: {} as ProviderAdapter, family: "deepseek" as const, name: "Pi/DeepSeek" },
};

describe("provider profiles", () => {
  it("has the fixed cross-family author, reviewer, and fallback assignments", () => {
    const codex = createProviderProfile("CODEX_PRIMARY", providers);
    const claude = createProviderProfile("CLAUDE_PRIMARY", providers);
    expect([codex.author.family, codex.fallbackAuthor.family, codex.reviewer.family, codex.fallbackReviewer.family]).toEqual(["codex", "claude", "claude", "deepseek"]);
    expect([claude.author.family, claude.fallbackAuthor.family, claude.reviewer.family, claude.fallbackReviewer.family]).toEqual(["claude", "codex", "codex", "deepseek"]);
  });

  it("uses configured family identity instead of model output claims", () => {
    const profile = createProviderProfile("CODEX_PRIMARY", providers);
    expect(isIndependentReceipt(profile.author, profile.reviewer)).toBe(true);
    expect(isIndependentReceipt(profile.author, { ...profile.reviewer, family: "codex" })).toBe(false);
  });

  it("uses fallback and sends high risk to humans when independent review is unavailable", () => {
    const profile = createProviderProfile("CODEX_PRIMARY", providers);
    expect(selectReviewer(profile, "high", { primaryAvailable: false, fallbackAvailable: true }).disposition).toBe("fallback");
    expect(selectReviewer(profile, "high", { primaryAvailable: false, fallbackAvailable: false })).toEqual({ disposition: "needs-human", reviewer: null });
  });

  it("never treats a same-family reviewer as an independent receipt", () => {
    const profile = { ...createProviderProfile("CODEX_PRIMARY", providers), reviewer: providers.codex, fallbackReviewer: providers.codex };
    expect(selectReviewer(profile, "high", { primaryAvailable: true, fallbackAvailable: true }).disposition).toBe("needs-human");
    expect(selectReviewer(profile, "normal", { primaryAvailable: true, fallbackAvailable: false }).disposition).toBe("advisory");
    expect(isIndependentReceipt(providers.codex, { ...providers.claude, adapter: providers.codex.adapter })).toBe(false);
  });

  it("offers only independently configured reviewers with enforced read-only isolation", () => {
    const author = { ...providers.codex, adapter: { workspaceIsolation: { readOnly: "enforced" as const, workspaceWrite: "enforced" as const } } as ProviderAdapter };
    const reviewer = { ...providers.claude, adapter: { workspaceIsolation: { readOnly: "enforced" as const, workspaceWrite: "unverified" as const } } as ProviderAdapter };
    const fallbackReviewer = { ...providers.deepseek, adapter: { workspaceIsolation: { readOnly: "unverified" as const, workspaceWrite: "unverified" as const } } as ProviderAdapter };
    expect(independentReviewCandidates({ name: "CODEX_PRIMARY", author, fallbackAuthor: reviewer, reviewer, fallbackReviewer })).toEqual([reviewer]);
    expect(independentReviewCandidates(
      { name: "CODEX_PRIMARY", author, fallbackAuthor: reviewer, reviewer, fallbackReviewer },
      reviewer,
    )).toEqual([]);
  });

  it("offers only Author and Explorer adapters that enforce the requested workspace boundary", () => {
    const profile = createProviderProfile("CODEX_PRIMARY", {
      codex: { ...providers.codex, adapter: { workspaceIsolation: { readOnly: "enforced", workspaceWrite: "enforced" } } as ProviderAdapter },
      claude: { ...providers.claude, adapter: { workspaceIsolation: { readOnly: "enforced", workspaceWrite: "unverified" } } as ProviderAdapter },
      deepseek: providers.deepseek,
    });
    expect(workspaceRoleCandidates(profile, "read-only").map((item) => item.family)).toEqual(["codex", "claude"]);
    expect(workspaceRoleCandidates(profile, "workspace-write").map((item) => item.family)).toEqual(["codex"]);
  });

  it("binds Provider Supervisor fallback records to the Outbox", () => {
    const store = new SqliteStore(":memory:");
    store.createRun("run-1", "task-1");
    const saved: string[] = [];
    const persistence = withFallbackOutbox({
      saveCheckpoint() {}, saveFailure() {}, saveFallback(record) { saved.push(record.fromProvider); },
    }, store, "run-1");
    persistence.saveFallback({ fromProvider: "Claude", reason: "unavailable" });
    expect(saved).toEqual(["Claude"]);
    expect(store.listPendingOutbox()[0]).toMatchObject({ type: "provider-fallback" });
    store.close();
  });
});
