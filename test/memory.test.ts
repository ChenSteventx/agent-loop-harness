import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SanitizedFactBundle } from "../src/evaluation/facts.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import {
  approveCandidateMemory,
  deriveCandidateMemories,
  expireCandidateMemories,
  rejectCandidateMemory,
  retrieveApprovedMemory,
  scanCandidateMemory,
} from "../src/memory/candidates.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function facts(id: string, factHash: string, projectScope = "generic-node"): SanitizedFactBundle {
  return {
    schemaVersion: 1,
    source: "real",
    exportedAt: "2026-07-15T00:00:00.000Z",
    factHash,
    run: {
      id,
      taskId: `task-${id}`,
      status: "ready",
      mergeSha: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      binding: {
        taskSpecHash: `task-hash-${id}`,
        acceptanceHash: `acceptance-${id}`,
        baselineCommit: `baseline-${id}`,
        risk: "low",
        executionTemplate: "solo",
        providerProfile: "CODEX_PRIMARY",
        projectAdapterName: projectScope,
        policyVersion: "generic-node/v2",
        verificationStepIds: ["test"],
      },
    },
    operations: [],
    evidence: [],
    events: [{ id: 1, type: "provider.failure", createdAt: "2026-07-15T00:00:01.000Z", failureClass: "quota" }],
    manifests: [],
    human: [],
    agentCalls: [],
    reviewerFindings: [],
  };
}

describe("quarantined Candidate Memory", () => {
  it("is disabled by default and requires scoped human approval before lexical retrieval", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-memory-"));
    temporaryDirectories.push(directory);
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const [candidate] = deriveCandidateMemories([
      facts("run-1", "fact-1"),
      facts("run-2", "fact-2"),
    ], { now: "2026-07-15T00:00:00.000Z" });
    expect(candidate).toMatchObject({ status: "candidate", supportCount: 2, projectScope: "generic-node" });
    store.installCandidateMemory(candidate!);

    expect(retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "provider quota fallback",
    })).toEqual([]);
    expect(retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "provider quota fallback", enabled: true,
    })).toEqual([]);

    const approved = approveCandidateMemory(store, {
      id: candidate!.id,
      approvedBy: "human-reviewer",
      reason: "supported by two independent real Runs",
      decidedAt: "2026-07-15T00:02:00.000Z",
    });
    expect(approved).toMatchObject({ status: "approved", decision: { authority: "human" } });
    const retrieved = retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "provider quota fallback", enabled: true,
      now: "2026-07-15T00:03:00.000Z",
    });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.matchedTerms).toEqual(expect.arrayContaining(["provider", "quota", "fallback"]));
    expect(retrieveApprovedMemory(store, {
      projectScope: "another-project", query: "provider quota fallback", enabled: true,
    })).toEqual([]);

    rejectCandidateMemory(store, {
      id: candidate!.id, rejectedBy: "human-reviewer", reason: "rollback after stale evidence",
      decidedAt: "2026-07-15T00:04:00.000Z",
    });
    expect(retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "provider quota fallback", enabled: true,
    })).toEqual([]);
    store.close();
  });

  it("blocks secrets, paths, project identifiers, duplicate content, and single-example overfit", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-memory-scan-"));
    temporaryDirectories.push(directory);
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const [overfit] = deriveCandidateMemories([facts("run-1", "fact-1")]);
    store.installCandidateMemory(overfit!);
    expect(scanCandidateMemory(overfit!)).toMatchObject({ passed: false, overfit: true });
    expect(() => approveCandidateMemory(store, {
      id: overfit!.id, approvedBy: "human", reason: "too soon",
    })).toThrow("failed approval scans");
    expect(scanCandidateMemory({ ...overfit!, summary: "Bearer token at C:\\secret\\file" }, {
      forbiddenIdentifiers: ["secret"],
    })).toMatchObject({ passed: false, overfit: true });
    expect(() => store.installCandidateMemory({ ...overfit!, id: `${overfit!.id}:duplicate` }))
      .toThrow("duplicates");
    expect(expireCandidateMemories(store, "2100-01-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({ status: "expired", decision: expect.objectContaining({ authority: "system-expiry" }) }),
    ]);
    store.close();
  });
});
