import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeWiredTargets } from "../src/evolution/proposals.js";

// Every proposable evolution target must trace to a real runtime decision
// point. The trace is locked at source level (the behavioral halves live in
// the full-task-replay and production-loop tests); a target whose consumer
// disappears fails here instead of silently becoming an empty evolution.
const consumerTraces: Record<string, Array<[string, string]>> = {
  "prompt-variant": [
    ["src/orchestrator.ts", "variant: binding.runtimeConfiguration?.promptVariant"],
    ["src/full-task-executor.ts", "variant: configuration.promptVariant"],
  ],
  "provider-routing": [
    ["src/orchestrator.ts", "orderProviderCandidates(binding, workspaceRoleCandidates"],
    ["src/full-task-executor.ts", "selectAuthor(options, configuration.providerOrder)"],
  ],
  "retry-policy": [
    ["src/orchestrator.ts", "maxAttempts: (binding.runtimeConfiguration?.retryLimit ?? 1) + 1"],
    ["src/full-task-executor.ts", "configuration.retryLimit"],
  ],
  "timeout-policy": [
    ["src/orchestrator.ts", "runtimeConfiguration?.timeoutMs ?? 10 * 60_000"],
    ["src/full-task-executor.ts", "timeoutMs: configuration.timeoutMs"],
  ],
};

describe("promotion target to runtime consumer traceability", () => {
  it("locks a source-level consumer for every runtime-wired target", () => {
    expect(Object.keys(consumerTraces).sort()).toEqual([...runtimeWiredTargets].sort());
    for (const target of runtimeWiredTargets) {
      for (const [file, evidence] of consumerTraces[target]!) {
        const source = readFileSync(resolve(file), "utf8");
        expect(source, `${target} lost its consumer in ${file}`).toContain(evidence);
      }
    }
  });

  it("keeps contextRanking wired even though it is not yet proposable", () => {
    const source = readFileSync(resolve("src/orchestrator.ts"), "utf8");
    expect(source).toContain("runtimeConfiguration?.contextRanking");
  });
});
