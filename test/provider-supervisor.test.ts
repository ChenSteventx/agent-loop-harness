import { describe, expect, it } from "vitest";
import {
  ProviderSupervisor,
  retryAfterMilliseconds,
  type ProviderFallbackRecord,
  type ProviderFailureEvidence,
  type ProviderSupervisorPersistence,
} from "../src/provider-supervisor.js";
import type { ProviderAdapter, ProviderFailureClass, ProviderRunRequest, ProviderRunResult } from "../src/provider.js";

const request: ProviderRunRequest = {
  invocationId: "inv-1",
  prompt: "bounded task",
  cwd: "/tmp",
  artifactDirectory: "/tmp/provider-supervisor",
  outputSchemaPath: "/tmp/schema.json",
};

class MemoryPersistence implements ProviderSupervisorPersistence {
  checkpoints: Array<{ invocationId: string; provider: string; threadId: string | null }> = [];
  failures: ProviderFailureEvidence[] = [];
  fallbacks: ProviderFallbackRecord[] = [];
  saveCheckpoint(value: (typeof this.checkpoints)[number]): void { this.checkpoints.push(value); }
  saveFailure(value: ProviderFailureEvidence): void { this.failures.push(value); }
  saveFallback(value: ProviderFallbackRecord): void { this.fallbacks.push(value); }
}

function result(provider: string, failureClass: ProviderFailureClass | null, stderr = ""): ProviderRunResult {
  return {
    invocationId: "inv-1", ok: failureClass === null, cancelled: false,
    identity: { provider, model: null, executable: provider, version: "1" },
    threadId: failureClass === null ? `${provider}-thread` : null,
    events: [], finalOutput: failureClass === null ? { status: "completed" } : null,
    stderr, exitCode: failureClass === null ? 0 : 1, signal: null, durationMs: 1,
    usage: null, failureClass, eventsPath: "events", finalOutputPath: "final", stderrPath: "stderr",
  };
}

function adapter(provider: string, outcomes: ProviderRunResult[]): ProviderAdapter & { calls: number } {
  return {
    calls: 0,
    async probe() { return { available: true, identity: result(provider, null).identity, error: null }; },
    async run() { this.calls += 1; return outcomes.shift() ?? result(provider, "unknown"); },
    async cancel() { return true; },
  };
}

function supervisor(adapters: ProviderAdapter[], persistence: MemoryPersistence, sleep: number[] = []) {
  return new ProviderSupervisor({
    adapters, persistence, authRecoveryCommand: "agent-loop auth login", unknownRecoveryCommand: "agent-loop status run-1",
    backoffMs: 25, sleep: async (ms) => { sleep.push(ms); },
  });
}

describe("ProviderSupervisor", () => {
  it("records a timeout once and requests fallback without retrying", async () => {
    const store = new MemoryPersistence();
    const primary = adapter("primary", [result("primary", "timeout")]);
    const outcome = await supervisor([primary], store).run(request);
    expect(primary.calls).toBe(1);
    expect(outcome.disposition).toBe("fallback");
    expect(store.failures[0]?.failureClass).toBe("timeout");
  });

  it("recovers from a temporary failure with one backoff and saves a checkpoint", async () => {
    const store = new MemoryPersistence();
    const sleeps: number[] = [];
    const primary = adapter("primary", [
      result("primary", "rate_limit", "Retry-After: 3"), result("primary", null),
    ]);
    const outcome = await supervisor([primary], store, sleeps).run(request);
    expect(outcome.disposition).toBe("succeeded");
    expect(primary.calls).toBe(2);
    expect(sleeps).toEqual([3_000]);
    expect(store.checkpoints).toEqual([{ invocationId: "inv-1", provider: "primary", threadId: "primary-thread" }]);
  });

  it("does not retry quota and records fallback history before using another provider", async () => {
    const store = new MemoryPersistence();
    const primary = adapter("primary", [result("primary", "quota")]);
    const fallback = adapter("fallback", [result("fallback", null)]);
    const outcome = await supervisor([primary, fallback], store).run(request);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(outcome.disposition).toBe("succeeded");
    expect(store.fallbacks).toEqual([{ fromProvider: "primary", reason: "quota" }]);
  });

  it("does not confuse quota exhaustion with low-quality output", async () => {
    const store = new MemoryPersistence();
    const primary = adapter("primary", [result("primary", "quota")]);
    const fallback = adapter("fallback", [result("fallback", null)]);
    await supervisor([primary, fallback], store).run(request);
    expect(store.failures.map(({ failureClass }) => failureClass)).toEqual(["quota"]);
    expect(store.failures.map(({ failureClass }) => failureClass)).not.toContain("invalid_output");
  });

  it("blocks auth failures with a deterministic recovery command", async () => {
    const store = new MemoryPersistence();
    const primary = adapter("primary", [result("primary", "auth")]);
    const outcome = await supervisor([primary], store).run(request);
    expect(outcome.disposition).toBe("blocked");
    expect(outcome.recoveryCommand).toBe("agent-loop auth login");
    expect(primary.calls).toBe(1);
  });

  it("blocks unknown failures with a distinct deterministic recovery command", async () => {
    const outcome = await supervisor([adapter("primary", [result("primary", "unknown")])], new MemoryPersistence()).run(request);
    expect(outcome).toMatchObject({ disposition: "blocked", recoveryCommand: "agent-loop status run-1" });
  });

  it("retries malformed output once, then falls back", async () => {
    const store = new MemoryPersistence();
    const primary = adapter("primary", [result("primary", "invalid_output"), result("primary", "invalid_output")]);
    const fallback = adapter("fallback", [result("fallback", null)]);
    const outcome = await supervisor([primary, fallback], store).run(request);
    expect(outcome.disposition).toBe("succeeded");
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
    expect(store.failures.map((failure) => failure.attempt)).toEqual([1, 2]);
  });

  it("prevents retry storms and cools down repeatedly failing providers", async () => {
    let now = 1_000;
    const store = new MemoryPersistence();
    const primary = adapter("primary", [
      result("primary", "transient"), result("primary", "transient"), result("primary", null),
    ]);
    const service = new ProviderSupervisor({
      adapters: [primary], persistence: store, authRecoveryCommand: "agent-loop auth login", unknownRecoveryCommand: "agent-loop status run-1",
      backoffMs: 1, cooldownThreshold: 2, cooldownMs: 100, now: () => now, sleep: async () => {},
    });
    await service.run(request);
    await service.run(request);
    expect(primary.calls).toBe(2);
    expect(store.fallbacks.at(-1)).toEqual({ fromProvider: "primary", reason: "cooldown" });
    now += 101;
    expect((await service.run(request)).disposition).toBe("succeeded");
    expect(primary.calls).toBe(3);
  });
});

describe("Retry-After parsing", () => {
  it("accepts delta seconds and rejects absent values", () => {
    expect(retryAfterMilliseconds("retry-after: 12")).toBe(12_000);
    expect(retryAfterMilliseconds("try later")).toBeNull();
  });
});
