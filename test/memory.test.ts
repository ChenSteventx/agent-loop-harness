import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { SanitizedFactBundle } from "../src/evaluation/facts.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import {
  approveCandidateMemory,
  deriveCandidateMemories,
  expireCandidateMemories,
  invalidateCandidateMemory,
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
    evidence: [{
      id: `${id}:verification-failure`, kind: "verification_failure", status: "valid",
      commitSha: `commit-${id}`, policyVersion: "generic-node/v2", stepId: "test",
      dependencyHash: `dependency-${id}`, createdAt: "2026-07-15T00:00:01.000Z", invalidatedAt: null,
      findingValidation: null,
    }],
    events: [{ id: 1, type: "provider.failure", createdAt: "2026-07-15T00:00:01.000Z", failureClass: "quota" }],
    manifests: [],
    human: [],
    agentCalls: [],
    reviewerFindings: [],
  };
}

describe("quarantined Candidate Memory", () => {
  it("migrates an earlier Candidate Memory constraint before invalidation is used", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-memory-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "evaluation.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE candidate_memories (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'approved', 'rejected', 'superseded', 'expired')),
        memory_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(project_scope, content_hash)
      );
    `);
    legacy.close();
    const store = new EvaluationStore(path);
    const schema = store.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidate_memories'",
    ).get() as { sql: string };
    expect(schema.sql).toContain("evaluating");
    expect(schema.sql).toContain("deprecated");
    store.close();
  });

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
      projectScope: "generic-node", query: "failure signature affected useful root",
    })).toEqual([]);
    expect(retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "failure signature affected useful root", enabled: true,
    })).toEqual([]);

    const approved = approveCandidateMemory(store, {
      id: candidate!.id,
      approvedBy: "human-reviewer",
      reason: "supported by two independent real Runs",
      decidedAt: "2026-07-15T00:02:00.000Z",
    });
    expect(approved).toMatchObject({ status: "approved", decision: { authority: "human" } });
    const retrieved = retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "failure signature affected useful root", enabled: true,
      now: "2026-07-15T00:03:00.000Z",
    });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.matchedTerms).toEqual(expect.arrayContaining(["failure", "signature", "root"]));
    expect(retrieveApprovedMemory(store, {
      projectScope: "another-project", query: "failure signature affected useful root", enabled: true,
    })).toEqual([]);

    invalidateCandidateMemory(store, {
      id: candidate!.id, invalidatedBy: "human-reviewer", reason: "rollback after stale evidence",
      decidedAt: "2026-07-15T00:04:00.000Z",
    });
    expect(retrieveApprovedMemory(store, {
      projectScope: "generic-node", query: "failure signature affected useful root", enabled: true,
    })).toEqual([]);
    store.close();
  });

  it("blocks secrets, paths, project identifiers, duplicate content, and single-example overfit", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-memory-scan-"));
    temporaryDirectories.push(directory);
    const store = new EvaluationStore(join(directory, "evaluation.sqlite"));
    const [overfit] = deriveCandidateMemories([facts("run-1", "fact-1")]);
    store.installCandidateMemory(overfit!);
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "memory-quarantined"))
      .toMatchObject({ payload: expect.objectContaining({ candidateId: overfit!.id }) });
    expect(scanCandidateMemory(overfit!)).toMatchObject({ passed: false, overfit: true });
    const [sameRunTwice] = deriveCandidateMemories([facts("run-same", "fact-a"), facts("run-same", "fact-b")]);
    expect(scanCandidateMemory(sameRunTwice!)).toMatchObject({ passed: false, overfit: true });
    expect(() => approveCandidateMemory(store, {
      id: overfit!.id, approvedBy: "human", reason: "too soon",
    })).toThrow("failed approval scans");
    expect(scanCandidateMemory({ ...overfit!, summary: "Bearer token at C:\\secret\\file" }, {
      forbiddenIdentifiers: ["secret"],
    })).toMatchObject({ passed: false, overfit: true });
    expect(scanCandidateMemory({ ...overfit!, preconditions: ["policy /home/leaky/path"] }))
      .toMatchObject({ absolutePaths: ["/home/leaky/path"] });
    expect(scanCandidateMemory({ ...overfit!, counterexamples: ["run with access_token inside"] }))
      .toMatchObject({ secretMarkers: ["access_token"] });
    expect(() => store.installCandidateMemory({ ...overfit!, id: `${overfit!.id}:duplicate` }))
      .toThrow("duplicates");
    expect(store.listPendingEvolutionOutbox().find((event) => event.type === "memory-conflict"))
      .toMatchObject({ payload: expect.objectContaining({ conflictingMemoryId: overfit!.id }) });
    expect(expireCandidateMemories(store, "2100-01-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({ status: "deprecated", decision: expect.objectContaining({ authority: "system-expiry" }) }),
    ]);
    store.close();
  });

  it("derives repository-scoped failure-signature experience instead of platform boilerplate", () => {
    const failing = [facts("run-1", "fact-1"), facts("run-2", "fact-2")];
    const passing: SanitizedFactBundle = {
      ...facts("run-pass", "fact-pass"),
      evidence: [],
    };
    const [candidate] = deriveCandidateMemories([...failing, passing], { now: "2026-07-18T00:00:00.000Z" });
    expect(candidate).toMatchObject({
      kind: "failure-pattern",
      operationType: "verification",
      failureSignature: ["test"],
      rootCause: "unknown",
      usefulTests: ["test"],
      supportCount: 2,
    });
    expect(candidate!.summary).toContain("failure signature [test]");
    expect(candidate!.summary).toContain("root cause: unknown");
    expect(candidate!.preconditions).toEqual(expect.arrayContaining([
      "project generic-node",
      "verification steps test",
      "policy generic-node/v2",
    ]));
    expect(candidate!.counterexamples).toEqual(["run run-pass passed matching verification steps"]);
    expect(candidate!.sourceRunIds).toEqual(["run-1", "run-2"]);
    expect(candidate!.sourceCommits).toEqual(["commit-run-1", "commit-run-2"]);

    const confirmed = deriveCandidateMemories([
      {
        ...facts("run-3", "fact-3"),
        reviewerFindings: [{
          id: "finding-1", category: "missing-null-check", severity: "high",
          outcome: "confirmed", authority: "machine",
        }],
      },
      facts("run-4", "fact-4"),
    ], { now: "2026-07-18T00:00:00.000Z" });
    expect(confirmed[0]).toMatchObject({ rootCause: "confirmed(missing-null-check)" });
    expect(confirmed[0]!.summary).toContain("root cause: confirmed(missing-null-check)");
  });
});
