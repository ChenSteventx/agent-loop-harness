import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunBinding } from "../src/bindings.js";
import { buildClaudeCodeArgs } from "../src/claude-provider.js";
import { boundAdvisoryText, defaultRunBudget } from "../src/budget.js";
import {
  renderMemoryAdvisory,
  retrieveApprovedMemory,
  type CandidateMemory,
} from "../src/memory/candidates.js";
import { CodexCliAdapter } from "../src/provider.js";
import { renderReviewerPrompt } from "../src/reviewer.js";
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
    // Inherited object-prototype names must not resolve to builders: a
    // persisted "toString" variant would otherwise render a boundary-free
    // prompt instead of failing closed.
    for (const inherited of ["toString", "valueOf", "constructor", "hasOwnProperty"]) {
      expect(() => authorPrompt(task, null, { variant: inherited }))
        .toThrow("Unregistered author prompt variant");
    }
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

describe("low-risk-review-rubric runtime wiring", () => {
  const reviewerInput = {
    task,
    diff: "diff --git a/x b/x",
    reviewedCommit: "c".repeat(40),
    diffHash: "d".repeat(64),
    controlStateHash: "e".repeat(64),
    verificationEvidence: [],
    allowedRepositoryRoots: ["/tmp/worktree"],
    contextBudget: 100_000,
  };

  it("injects the rubric line only when one is supplied", () => {
    const withRubric = renderReviewerPrompt({ ...reviewerInput, lowRiskRubric: "verify acceptance evidence" });
    expect(withRubric).toContain("Low-risk review rubric: verify acceptance evidence");
    expect(renderReviewerPrompt(reviewerInput)).not.toContain("Low-risk review rubric");
    expect(renderReviewerPrompt({ ...reviewerInput, lowRiskRubric: null })).not.toContain("Low-risk review rubric");
  });

  it("allows explicit template escalation but never a downgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-loop-template-"));
    temporaryDirectories.push(root);
    const bindingInput = {
      taskSpecPath: (() => { const p = join(root, "task.yaml"); writeFileSync(p, "id: WIRE-1"); return p; })(),
      taskSpec: task,
      baselineCommit: "a".repeat(40),
      sourceRepository: root,
      worktreePath: join(root, "worktree"),
      providerProfile: "CODEX_PRIMARY",
      projectAdapter: { name: "generic-node", policyVersion: "generic-node/v2" } as never,
      budget: defaultRunBudget(),
    };
    const escalated = createRunBinding({ ...bindingInput, effectiveRisk: "low", executionTemplate: "reviewed" });
    expect(escalated.executionTemplate).toBe("reviewed");
    expect(() => createRunBinding({ ...bindingInput, effectiveRisk: "high", executionTemplate: "solo" }))
      .toThrow("No valid execution template");
  });
});

function approvedMemory(overrides: Partial<CandidateMemory>): CandidateMemory {
  return {
    schemaVersion: 1,
    id: "memory-1",
    projectScope: "generic-node",
    repositoryScope: "repo",
    operationType: "verification",
    kind: "failure-pattern",
    summary: "check.mjs asserts trailing punctuation in greetings",
    terms: ["greeting", "punctuation", "wired"],
    contentHash: "hash-1",
    sourceFactHashes: ["fact-1"],
    sourceRunIds: ["run-1"],
    sourceCommits: ["c".repeat(40)],
    evidenceRefs: ["evidence-1"],
    supportCount: 1,
    failureSignature: ["assertion"],
    rootCause: "missing punctuation",
    usefulTests: ["check"],
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    validatedAt: "2026-01-02T00:00:00.000Z",
    invalidationReason: null,
    preconditions: [],
    counterexamples: [],
    decision: null,
    ...overrides,
  };
}

describe("memory-retrieval runtime wiring", () => {
  const repository = {
    listCandidateMemories: () => [
      approvedMemory({}),
      approvedMemory({ id: "memory-2", status: "candidate", summary: "unapproved noise" }),
    ],
  } as never;

  it("renders an explainable advisory from approved matches only", () => {
    const results = retrieveApprovedMemory(repository, {
      projectScope: "generic-node",
      query: "prove wired greeting punctuation",
      enabled: true,
      limit: 3,
    });
    const advisory = renderMemoryAdvisory(results);
    expect(advisory).toContain("check.mjs asserts trailing punctuation");
    expect(advisory).toContain("matched:");
    expect(advisory).not.toContain("unapproved noise");
    expect(renderMemoryAdvisory([])).toBeNull();
    expect(retrieveApprovedMemory(repository, {
      projectScope: "generic-node",
      query: "prove wired greeting punctuation",
    })).toEqual([]);
  });

  it("freezes a byte-bounded advisory into the run binding", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-loop-memory-binding-"));
    temporaryDirectories.push(root);
    const taskSpecPath = join(root, "task.yaml");
    writeFileSync(taskSpecPath, "id: WIRE-1");
    const binding = createRunBinding({
      taskSpecPath,
      taskSpec: task,
      baselineCommit: "a".repeat(40),
      sourceRepository: root,
      worktreePath: join(root, "worktree"),
      providerProfile: "CODEX_PRIMARY",
      projectAdapter: { name: "generic-node", policyVersion: "generic-node/v2" } as never,
      budget: { ...defaultRunBudget(), maximumExplorerAdvisoryBytes: 8 },
      memoryAdvisory: "0123456789 overflows the cap",
    });
    expect(binding.memoryAdvisory).toBe("01234567");
    expect(boundAdvisoryText(null, 8)).toBeNull();
    expect(boundAdvisoryText("short", 8)).toBe("short");
  });

  it("honors the byte bound even when the cut tears a multibyte character", () => {
    // 4 ASCII bytes + é (2 bytes): a cut at 5 tears é into a replacement
    // character (3 bytes encoded) — the result must still fit the bound.
    for (const [text, limit] of [["abcdé", 5], ["ééééé", 7], ["a🙂b", 3]] as const) {
      const bounded = boundAdvisoryText(text, limit);
      expect(Buffer.byteLength(bounded ?? "", "utf8")).toBeLessThanOrEqual(limit);
    }
  });

  it("retrieves only memory derived from the same repository", () => {
    const scoped = {
      listCandidateMemories: () => [
        approvedMemory({ id: "repo-a", repositoryScope: "scope-a" }),
        approvedMemory({ id: "repo-b", repositoryScope: "scope-b", summary: "greeting punctuation from another repository" }),
      ],
    } as never;
    const results = retrieveApprovedMemory(scoped, {
      projectScope: "generic-node",
      repositoryScope: "scope-a",
      query: "prove wired greeting punctuation",
      enabled: true,
    });
    expect(results.map((result) => result.memory.id)).toEqual(["repo-a"]);
  });
});
