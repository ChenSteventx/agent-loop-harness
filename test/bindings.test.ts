import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceHash,
  canonicalJson,
  createRunBinding,
  evidenceDependencies,
  evidenceDependencyHash,
  operationInputHash,
  taskSpecHash,
} from "../src/bindings.js";
import type { ProjectAdapter } from "../src/ports.js";
import { SqliteStore } from "../src/store.js";
import type { TaskSpec } from "../src/task-spec.js";

const temporaryDirectories: string[] = [];
const task: TaskSpec = {
  id: "T-1",
  goal: "bind the task",
  acceptance: ["typecheck passes", "tests pass"],
  risk: "low",
  verification: [{ id: "check", argv: ["node", "check.mjs"] }],
};
const adapter: ProjectAdapter = {
  name: "fixture",
  policyVersion: "fixture/v1",
  verificationCommands: (value) => value.verification,
  postMergeCommands: (value) => value.verification,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical run and evidence bindings", () => {
  it("hashes semantic objects deterministically and changes for every authoritative dependency", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const base = evidenceDependencies({
      commitSha: "commit-a",
      taskSpecHash: taskSpecHash(task),
      acceptanceHash: acceptanceHash(task.acceptance),
      policyVersion: "fixture/v1",
      stepId: "verify:check",
      operationInputHash: operationInputHash({ argv: ["node", "check.mjs"] }),
    });
    const original = evidenceDependencyHash(base);
    const changes = [
      { ...base, commitSha: "commit-b" },
      { ...base, taskSpecHash: taskSpecHash({ ...task, goal: "changed" }) },
      { ...base, acceptanceHash: acceptanceHash(["different acceptance"]) },
      { ...base, policyVersion: "fixture/v2" },
      { ...base, stepId: "verify:other" },
      { ...base, operationInputHash: operationInputHash({ argv: ["node", "other.mjs"] }) },
    ];
    expect(changes.map(evidenceDependencyHash)).not.toContain(original);
    expect(new Set(changes.map(evidenceDependencyHash)).size).toBe(changes.length);
  });

  it("persists one immutable Run snapshot plus canonical operation and Evidence inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-binding-"));
    temporaryDirectories.push(directory);
    const taskPath = join(directory, "task.yaml");
    writeFileSync(taskPath, "fixture\n");
    const binding = createRunBinding({
      taskSpecPath: taskPath,
      taskSpec: task,
      baselineCommit: "base",
      sourceRepository: directory,
      worktreePath: join(directory, "worktree"),
      providerProfile: "CODEX_PRIMARY",
      projectAdapter: adapter,
    });
    const path = join(directory, "state.sqlite");
    const first = new SqliteStore(path);
    first.createBoundRun("run-1", task.id, binding);
    const operationInput = { argv: ["node", "check.mjs"], phase: "verify" };
    const operation = first.createOperation({
      id: "op-1", runId: "run-1", kind: "verify", idempotencyKey: "verify-1", input: operationInput,
    });
    const dependencies = evidenceDependencies({
      commitSha: "candidate",
      taskSpecHash: binding.taskSpecHash,
      acceptanceHash: binding.acceptanceHash,
      policyVersion: binding.policyVersion,
      stepId: "verify:check",
      operationInputHash: operationInputHash(operationInput),
    });
    first.installEvidence({
      id: "e-1", runId: "run-1", operationId: operation.id, kind: "command",
      commitSha: dependencies.commitSha, policyVersion: dependencies.policyVersion,
      stepId: dependencies.stepId, dependencyHash: evidenceDependencyHash(dependencies),
      dependencies, data: { exitCode: 0 },
    });
    expect(() => first.createOperation({
      id: "op-2", runId: "run-1", kind: "verify", idempotencyKey: "verify-1", input: { argv: ["false"] },
    })).toThrow("different input");
    expect(() => first.installEvidence({
      id: "e-unbound", runId: "run-1", operationId: null, kind: "command",
      commitSha: "candidate", policyVersion: binding.policyVersion, stepId: "verify:other",
      dependencyHash: "legacy", data: {},
    })).toThrow("fully bound");
    first.close();

    const reopened = new SqliteStore(path);
    expect(reopened.getRun("run-1")?.binding).toEqual(binding);
    expect(reopened.getOperation("op-1")).toMatchObject({
      input: operationInput,
      inputHash: operationInputHash(operationInput),
    });
    expect(reopened.listEvidence("run-1")[0]).toMatchObject({
      dependencyVersion: 1,
      dependencies,
    });
    reopened.close();
  });
});
