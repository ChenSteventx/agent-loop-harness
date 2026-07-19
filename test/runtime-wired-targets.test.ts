import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeCodeArgs } from "../src/claude-provider.js";
import { CodexCliAdapter } from "../src/provider.js";
import { authorPrompt, authorPromptVariants } from "../src/roles.js";
import type { TaskSpec } from "../src/task-spec.js";

const task: TaskSpec = {
  id: "WIRE-1",
  goal: "prove wired targets change execution",
  acceptance: ["first criterion", "second criterion"],
  risk: "low",
  verification: [{ id: "check", argv: ["node", "check.mjs"] }],
};

// Every variant must carry the safety contract verbatim — variants change
// authoring strategy, never the boundary.
const boundaryLines = [
  "Work only in the current worktree. Edit files only; do not run git add, git commit, or change Git metadata.",
  "Leave a non-empty working diff for the Harness to inspect and commit deterministically.",
  "Return only a concise summary and the changedFiles array required by the Author output schema.",
];

describe("prompt-variant runtime wiring", () => {
  it("selects a genuinely different registered template per variant", () => {
    const baseline = authorPrompt(task, null);
    const alternative = authorPrompt(task, null, { variant: "acceptance-first" });
    expect(authorPromptVariants).toContain("baseline");
    expect(authorPromptVariants).toContain("acceptance-first");
    expect(alternative).not.toBe(baseline);
    expect(baseline.startsWith("Task: WIRE-1")).toBe(true);
    expect(alternative.startsWith("Acceptance criteria to satisfy")).toBe(true);
    for (const line of boundaryLines) {
      expect(baseline).toContain(line);
      expect(alternative).toContain(line);
    }
  });

  it("defaults to baseline and fails closed on unregistered variants", () => {
    expect(authorPrompt(task, null, {})).toBe(authorPrompt(task, null));
    expect(() => authorPrompt(task, null, { variant: "concise-v2" }))
      .toThrow("Unregistered author prompt variant");
  });

  it("keeps advisories in every variant", () => {
    for (const variant of authorPromptVariants) {
      const prompt = authorPrompt(task, "explorer says X", { variant, memoryAdvisory: "memory says Y" });
      expect(prompt).toContain("Explorer advisory report: explorer says X");
      expect(prompt).toContain("Approved memory advisory: memory says Y");
    }
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("role-model-selection runtime wiring", () => {
  it("threads the per-invocation model override into the Claude argument list", () => {
    const overridden = buildClaudeCodeArgs([], "challenger-model", "{}", null, "workspace-write");
    expect(overridden.slice(overridden.indexOf("--model"))).toEqual(["--model", "challenger-model"]);
    expect(buildClaudeCodeArgs([], null, "{}", null, "workspace-write")).not.toContain("--model");
  });

  it("reports the overridden model in the Codex result identity, not the constructor model", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-loop-role-model-"));
    temporaryDirectories.push(root);
    const schema = join(root, "schema.json");
    writeFileSync(schema, JSON.stringify({ type: "object" }));
    const provider = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [resolve("test/fixtures/fake-codex.mjs")],
      provider: "fixture-provider",
      model: "fixture-model",
      sandbox: "workspace-write",
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 10_000,
      environment: { ...process.env, FAKE_CODEX_MODE: "success" },
    });
    const result = await provider.run({
      invocationId: "role-model-1",
      prompt: "Perform the bounded fixture task.",
      cwd: root,
      artifactDirectory: join(root, "artifacts"),
      outputSchemaPath: schema,
      model: "challenger-model",
    });
    expect(result.identity.model).toBe("challenger-model");
    const baseline = await provider.run({
      invocationId: "role-model-2",
      prompt: "Perform the bounded fixture task.",
      cwd: root,
      artifactDirectory: join(root, "artifacts-2"),
      outputSchemaPath: schema,
    });
    expect(baseline.identity.model).toBe("fixture-model");
  });
});
