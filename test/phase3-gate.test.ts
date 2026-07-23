import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runStatuses } from "../src/domain.js";
import { disabledCanaryPolicy } from "../src/evolution/canary.js";
import { evolutionTargets } from "../src/evolution/proposals.js";
import { candidateMemoryDefaults } from "../src/memory/candidates.js";

const gates = [
  [1, "formal Run statuses are unchanged", "src/domain.ts", "open"],
  [2, "Phase 3 failure cannot rewrite a development Run", "test/architecture.test.ts", "sidecar boundary"],
  [3, "Replay leaves Run, Operation, Event, and Evidence unchanged", "test/evaluation-replay.test.ts", "toBe(before)"],
  [4, "legacy runs without manifests are not manifest-complete Replay", "test/evaluation-replay.test.ts", "manifest_complete_replayability"],
  [5, "proposal generation cannot read Holdout", "test/evaluation-replay.test.ts", "inaccessible"],
  [6, "Candidate Memory cannot self-approve", "test/memory.test.ts", "human approval"],
  [7, "Candidate Memory is not injected by default", "src/memory/candidates.ts", "retrievalMode: \"off\""],
  [8, "Reviewer receives no Author strategy memory", "test/architecture.test.ts", "src/memory"],
  [9, "cross-project retrieval is rejected", "test/memory.test.ts", "another-project"],
  [10, "expired or invalidated memory is not retrievable", "test/memory.test.ts", "invalidateCandidateMemory"],
  [11, "secret and prompt-injection-like candidates cannot be approved", "test/memory.test.ts", "Bearer token"],
  [12, "there is exactly one active Champion", "test/evolution.test.ts", "already has an active Champion"],
  [13, "guardrail regression blocks promotion", "test/compare-shadow.test.ts", "guardrail"],
  [14, "Shadow cannot install Evidence or write Run state", "test/compare-shadow.test.ts", "non-authoritative"],
  [15, "Canary is disabled by default", "test/canary.test.ts", "Canary is disabled"],
  [16, "high and non-low risk never enter automatic Canary", "test/canary.test.ts", "assignment-normal"],
  [17, "Canary allocation is stable", "test/canary.test.ts", "stableCanaryBucket"],
  [18, "rollback restores the preceding Champion", "test/evolution.test.ts", "restored"],
  [19, "sidecar failure is outside the formal task path", "test/architecture.test.ts", "formal Run state"],
  [20, "Fixture proves mechanism but not production readiness", "test/evaluation-metrics.test.ts", "fixtureOnly"],
  [21, "missing or forged Comparison cannot promote", "test/evolution.test.ts", "missing-promotion"],
  [22, "fixture, no-Holdout, and failed Primary Metric comparisons cannot promote", "test/evolution.test.ts", "no-holdout-comparison"],
  [23, "Verify-only cannot evaluate prompt or provider targets", "test/compare-shadow.test.ts", "Verify-only evaluator cannot evaluate"],
  [24, "formal low-risk Fake Canary uses Challenger config", "test/production-loop.test.ts", "formal-challenger"],
  [25, "formal high-risk Run always uses Champion", "test/production-loop.test.ts", "production-cli-high-risk"],
  [26, "SMTP plaintext authentication is rejected", "test/notifications.test.ts", "requires TLS or STARTTLS"],
  [27, "Digest windows use Event time", "test/evolution-notifications.test.ts", "old-updated-run"],
  [28, "Verify-only cannot evaluate Memory Retrieval strategy", "test/compare-shadow.test.ts", "memory-retrieval-proposal"],
  [29, "Canary rollback restores the Champion for the next formal Run", "test/production-loop.test.ts", "canary-chain-champion-after-rollback"],
  [30, "formal runtime reads evaluation state read-only", "src/cli-main.ts", "readOnly: true"],
  [31, "proposals are limited to runtime-wired targets", "test/evolution.test.ts", "unsupported-runtime-target"],
  [32, "the vertical slice runs compare, shadow, canary, and rollback through the CLI", "test/phase3-vertical-slice.test.ts", "slice-rollback"],
  [33, "proposal evaluation requires persisted comparison evidence", "src/cli-main.ts", "requires a persisted completed Comparison"],
  [34, "production readiness stays closed on fixture-scale data", "test/phase3-vertical-slice.test.ts", "canaryReady: false"],
  [35, "prompt variants come from a bounded registry and keep the safety boundary", "test/runtime-wired-targets.test.ts", "Unregistered author prompt variant"],
  [36, "role model overrides are honored in arguments and reported identity", "test/runtime-wired-targets.test.ts", "reports the overridden model in the Codex result identity"],
  [37, "template escalation cannot downgrade below the risk floor", "test/runtime-wired-targets.test.ts", "No valid execution template"],
  [38, "memory advisories are frozen into the binding and byte-bounded", "test/runtime-wired-targets.test.ts", "freezes a byte-bounded advisory into the run binding"],
  [39, "every runtime-wired target traces to consumers in both runtimes", "test/target-consumer-trace.test.ts", "locks a source-level consumer for every runtime-wired target"],
] as const;

describe("Phase 3 final gate traceability", () => {
  it.each(gates)("Gate %i: %s", (id, _name, file, evidence) => {
    const source = readFileSync(resolve(file), "utf8");
    expect(source, `Gate ${id} evidence is missing from ${file}`).toContain(evidence);

    if (id === 1) {
      expect(runStatuses).toEqual(["open", "ready", "merged", "done", "blocked", "failed", "cancelled"]);
    }
    if (id === 7) {
      expect(candidateMemoryDefaults).toMatchObject({ retrievalMode: "off", autoPromote: false, crossProject: false });
    }
    if (id === 12) expect(evolutionTargets).not.toContain("risk-thresholds");
    if (id === 15) expect(disabledCanaryPolicy).toMatchObject({ enabled: false, basisPoints: 0, maxTasks: 0 });
  });
});
