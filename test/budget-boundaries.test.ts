import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetExceededError, defaultRunBudget, type RunBudget } from "../src/budget.js";
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
