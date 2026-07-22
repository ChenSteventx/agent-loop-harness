import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunBinding } from "../src/bindings.js";
import { GenericNodeProjectAdapter } from "../src/project.js";
import { SqliteStore } from "../src/store.js";
import type { TaskSpec } from "../src/task-spec.js";
import { inspectFrozenTopology } from "../src/topology-inspector.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("inspectFrozenTopology", () => {
  it("reads a frozen topology without changing formal state", () => {
    const loopHome = temporaryDirectory("agent-loop-topology-inspector-");
    const taskSpecPath = join(loopHome, "task.yaml");
    writeFileSync(taskSpecPath, "placeholder");
    const taskSpec: TaskSpec = {
      id: "TOPOLOGY-READ-1",
      goal: "inspect topology without writes",
      acceptance: ["formal state is unchanged"],
      risk: "low",
      verification: [{ id: "check", argv: ["node", "check.mjs"] }],
    };
    const binding = createRunBinding({
      taskSpecPath,
      taskSpec,
      baselineCommit: "baseline",
      sourceRepository: loopHome,
      worktreePath: join(loopHome, "worktree"),
      providerProfile: "CODEX_PRIMARY",
      projectAdapter: new GenericNodeProjectAdapter(),
    });
    if (binding.version !== 2) throw new Error("Expected a V2 binding");
    const statePath = join(loopHome, "state.sqlite");
    const store = new SqliteStore(statePath);
    store.createBoundRun("run-1", taskSpec.id, binding);
    const beforeVersion = store.database.pragma("user_version", { simple: true });
    store.close();
    const before = statSync(statePath);

    const view = inspectFrozenTopology(loopHome, "run-1");

    const after = statSync(statePath);
    const readOnlyStore = new SqliteStore(statePath, { readOnly: true });
    const afterVersion = readOnlyStore.database.pragma("user_version", { simple: true });
    readOnlyStore.close();
    expect(view).toMatchObject({ topologyHash: binding.workflow.topologyHash, pendingTraversal: null });
    expect(afterVersion).toBe(beforeVersion);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it("does not create a missing loop home while inspecting", () => {
    const parent = temporaryDirectory("agent-loop-topology-missing-");
    const loopHome = join(parent, "missing");
    expect(() => inspectFrozenTopology(loopHome, "run-1")).toThrow("No formal development state");
    expect(() => statSync(loopHome)).toThrow();
  });
});
