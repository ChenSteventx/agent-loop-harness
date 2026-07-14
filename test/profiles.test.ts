import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/provider.js";
import { createProviderProfile, isIndependentReceipt, selectReviewer, withFallbackOutbox } from "../src/profiles.js";
import { SqliteStore } from "../src/store.js";

const adapter = {} as ProviderAdapter;
const providers = {
  codex: { adapter, family: "codex" as const, name: "Codex" },
  claude: { adapter, family: "claude" as const, name: "Claude" },
  deepseek: { adapter, family: "deepseek" as const, name: "Pi/DeepSeek" },
};

describe("provider profiles", () => {
  it("has the fixed cross-family author, reviewer, and fallback assignments", () => {
    const codex = createProviderProfile("CODEX_PRIMARY", providers);
    const claude = createProviderProfile("CLAUDE_PRIMARY", providers);
    expect([codex.author.family, codex.reviewer.family, codex.fallbackReviewer.family]).toEqual(["codex", "claude", "deepseek"]);
    expect([claude.author.family, claude.reviewer.family, claude.fallbackReviewer.family]).toEqual(["claude", "codex", "deepseek"]);
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
