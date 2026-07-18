import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPromptWithinBudget,
  boundedJson,
  BudgetExceededError,
  defaultRunBudget,
  type RunBudget,
} from "../src/budget.js";
import { explorerReportSchema } from "../src/explorer.js";
import { authorOutputSchema } from "../src/role-output-schemas.js";
import { GitService } from "../src/execution.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-budget-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "budget@example.invalid"]);
  git(root, ["config", "user.name", "Budget Test"]);
  writeFileSync(join(root, "tracked.txt"), "baseline\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return root;
}

function budget(overrides: Partial<RunBudget>): RunBudget {
  return { ...defaultRunBudget(), ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("run budget boundaries in Git artifact collection", () => {
  it("fails closed on an oversized untracked file before reading its content", () => {
    const root = repository();
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(64 * 1024, 7));
    const service = new GitService(root, budget({ maximumUntrackedFileBytes: 1024 }));
    expect(() => service.diff()).toThrow(BudgetExceededError);
    expect(() => service.diff()).toThrow(/maximumUntrackedFileBytes.*huge\.bin/u);
  });

  it("fails closed on too many untracked files", () => {
    const root = repository();
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(root, `extra-${index}.txt`), String(index));
    }
    const service = new GitService(root, budget({ maximumUntrackedFiles: 3 }));
    expect(() => service.diff()).toThrow(/maximumUntrackedFiles/u);
  });

  it("fails closed on an oversized untracked total even when each file fits", () => {
    const root = repository();
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(root, `part-${index}.bin`), Buffer.alloc(600, index));
    }
    const service = new GitService(root, budget({
      maximumUntrackedFileBytes: 1024,
      maximumUntrackedTotalBytes: 2000,
    }));
    expect(() => service.diff()).toThrow(/maximumUntrackedTotalBytes/u);
  });

  it("fails closed on an oversized tracked diff in diff, stagedDiff, and diffBetween", () => {
    const root = repository();
    const baseline = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "tracked.txt"), "x".repeat(4096));
    const service = new GitService(root, budget({ maximumDiffBytes: 256 }));
    expect(() => service.diff()).toThrow(/maximumDiffBytes.*tracked diff/u);
    git(root, ["add", "."]);
    expect(() => service.stagedDiff()).toThrow(/maximumDiffBytes.*staged diff/u);
    git(root, ["-c", "user.email=budget@example.invalid", "-c", "user.name=Budget Test",
      "commit", "-m", "grow"]);
    expect(() => service.diffBetween(baseline)).toThrow(/maximumDiffBytes/u);
  });

  it("refuses untracked symlinks instead of following them", () => {
    // git ls-files --others lists symlinks (they are versionable); the old
    // stat-based check followed them, so a link to an unbounded target (for
    // example /dev/zero) reported a harmless size and then read without limit.
    const root = repository();
    symlinkSync("/dev/zero", join(root, "sneaky-link"));
    const service = new GitService(root, defaultRunBudget());
    expect(() => service.diff()).toThrow(/special file.*sneaky-link/u);
  });

  it("keeps the truncation envelope within its byte limit even for escape-heavy payloads", () => {
    const hostile = { data: "\\\"".repeat(20_000) };
    for (const limit of [512, 4096, 32_768]) {
      const envelope = boundedJson(hostile, limit);
      expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(limit);
      const parsed = JSON.parse(envelope) as { truncated: boolean; sha256: string; excerpt: string };
      expect(parsed.truncated).toBe(true);
      expect(JSON.stringify(hostile).startsWith(parsed.excerpt)).toBe(true);
    }
    // Below the bare-envelope floor the result is the minimum honest form.
    const floor = JSON.parse(boundedJson(hostile, 16)) as { excerpt: string };
    expect(floor.excerpt).toBe("");
  });

  it("keeps provider-facing JSON schemas cap-consistent with the parse-side schemas", () => {
    const author = JSON.parse(
      execFileSync("cat", ["schemas/author-output.schema.json"], { encoding: "utf8" }),
    ) as { properties: { summary: { maxLength?: number }; changedFiles: { maxItems?: number } } };
    expect(author.properties.summary.maxLength).toBe(4000);
    expect(author.properties.changedFiles.maxItems).toBe(500);
    const explorer = JSON.parse(
      execFileSync("cat", ["schemas/explorer-output.schema.json"], { encoding: "utf8" }),
    ) as { properties: { evidence: { maxItems?: number } } };
    expect(explorer.properties.evidence.maxItems).toBe(200);
    const reviewer = JSON.parse(
      execFileSync("cat", ["schemas/reviewer-output.schema.json"], { encoding: "utf8" }),
    ) as { properties: { findings: { maxItems?: number } } };
    expect(reviewer.properties.findings.maxItems).toBe(100);
  });

  it("bounds oversized JSON payloads into a traceable truncation envelope", () => {
    const report = {
      relevantFiles: [{ path: "src/app.ts", symbols: ["main"] }],
      likelyAffectedTests: ["test/app.test.ts"],
      evidence: [{ path: "src/app.ts", observation: "x".repeat(5000) }],
      importantUnknowns: [],
    };
    const full = JSON.stringify(report);
    expect(boundedJson(report, full.length + 10)).toBe(full);
    const bounded = JSON.parse(boundedJson(report, 512)) as {
      truncated: boolean; originalBytes: number; sha256: string; excerpt: string;
    };
    expect(bounded.truncated).toBe(true);
    expect(bounded.originalBytes).toBe(Buffer.byteLength(full));
    expect(bounded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(full.startsWith(bounded.excerpt)).toBe(true);
  });

  it("rejects oversized prompts and structurally unbounded role outputs", () => {
    expect(() => assertPromptWithinBudget("x".repeat(100), 50, "author"))
      .toThrow(/maximumPromptBytes.*author prompt/u);
    expect(assertPromptWithinBudget("small", 50, "author")).toBeUndefined();
    expect(explorerReportSchema.safeParse({
      relevantFiles: [], likelyAffectedTests: [],
      evidence: [{ path: "a.ts", observation: "y".repeat(3000) }],
      importantUnknowns: [],
    }).success).toBe(false);
    expect(authorOutputSchema.safeParse({
      summary: "z".repeat(5000), changedFiles: ["a.ts"],
    }).success).toBe(false);
  });

  it("keeps normal-sized workspaces unaffected and hash-stable", () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    writeFileSync(join(root, "new-file.txt"), "fresh\n");
    const bounded = new GitService(root, defaultRunBudget());
    const reference = new GitService(root);
    expect(bounded.diff()).toBe(reference.diff());
    expect(bounded.diffHash()).toBe(reference.diffHash());
  });
});
