import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunBinding } from "../src/bindings.js";
import { defaultRunBudget, validateRunBudget, BudgetExceededError } from "../src/budget.js";
import type { RunBinding } from "../src/domain.js";
import { GenericNodeProjectAdapter } from "../src/project.js";
import type { TaskSpec } from "../src/task-spec.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Every key the persisted binding schema carries. A field added to RunBinding
// but not built by createRunBinding (or vice versa) must fail this test loudly
// instead of drifting until a formal run breaks at runtime.
const expectedBindingKeys = [
  "version",
  "taskSpecPath",
  "taskSpec",
  "taskSpecHash",
  "acceptanceHash",
  "baselineCommit",
  "budget",
  "memoryAdvisory",
  "sourceRepository",
  "worktreePath",
  "risk",
  "executionTemplate",
  "providerProfile",
  "projectAdapterName",
  "policyVersion",
  "configurationVariantId",
  "configurationHash",
  "canaryAssignmentId",
  "configSource",
  "runtimeConfiguration",
].sort();

describe("RunBinding construction contract", () => {
  it("builds every schema field with defined values", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-binding-contract-"));
    temporaryDirectories.push(directory);
    const taskSpecPath = join(directory, "task.yaml");
    writeFileSync(taskSpecPath, "placeholder");
    const taskSpec: TaskSpec = {
      id: "CONTRACT-1",
      goal: "lock the binding construction contract",
      acceptance: ["all binding fields are constructed"],
      risk: "low",
      verification: [{ id: "check", argv: ["node", "check.mjs"] }],
    };
    const built = createRunBinding({
      taskSpecPath,
      taskSpec,
      baselineCommit: "baseline",
      sourceRepository: directory,
      worktreePath: join(directory, "worktree"),
      providerProfile: "CODEX_PRIMARY",
      projectAdapter: new GenericNodeProjectAdapter(),
    }) satisfies RunBinding;

    expect(Object.keys(built).sort()).toEqual(expectedBindingKeys);
    for (const [key, value] of Object.entries(built)) {
      expect(value, `binding field ${key} must be defined`).not.toBeUndefined();
    }
    expect(built).toMatchObject({
      version: 1,
      configSource: "default",
      configurationVariantId: null,
      runtimeConfiguration: null,
      budget: defaultRunBudget(),
    });
  });

  it("validates budget boundaries and rejects non-positive limits", () => {
    expect(validateRunBudget(defaultRunBudget())).toEqual(defaultRunBudget());
    expect(() => validateRunBudget({ ...defaultRunBudget(), maximumDiffBytes: 0 }))
      .toThrow("must be a positive integer");
    expect(() => validateRunBudget({ ...defaultRunBudget(), maximumUntrackedFiles: -1 }))
      .toThrow("must be a positive integer");
    const error = new BudgetExceededError("maximumDiffBytes", 10, 5, "tracked diff");
    expect(error.message).toContain("maximumDiffBytes");
    expect(error.name).toBe("BudgetExceededError");
  });
});
