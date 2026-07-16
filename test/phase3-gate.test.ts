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
