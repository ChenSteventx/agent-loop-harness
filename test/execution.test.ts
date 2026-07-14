import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRunner, GitService, WorktreeService } from "../src/execution.js";

const temporaryDirectories: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-git-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "agent-loop@example.invalid"]);
  git(root, ["config", "user.name", "Agent Loop Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitService and WorktreeService", () => {
  it("reports dirty state and a changing diff hash", () => {
    const root = repository();
    const service = new GitService(root);
    const cleanHash = service.diffHash();
    expect(service.isDirty()).toBe(false);

    writeFileSync(join(root, "tracked.txt"), "two\n");
    expect(service.isDirty()).toBe(true);
    expect(service.diffHash()).not.toBe(cleanHash);
    expect(service.state().branch).toBe("main");
  }, 20_000);

  it("creates, lists, and removes an isolated worktree", () => {
    const root = repository();
    const worktreePath = join(root, "..", `task-worktree-${Date.now()}`);
    temporaryDirectories.push(worktreePath);
    const service = new WorktreeService(root);

    expect(() => service.create(root, "agent-loop/not-isolated")).toThrow("Source checkout");
    const created = service.create(worktreePath, "agent-loop/task-1");
    expect(created.path.toLowerCase()).toContain("task-worktree-");
    expect(service.list().some((item) => item.branch === "agent-loop/task-1")).toBe(true);
    service.remove(worktreePath);
    expect(service.list().some((item) => item.branch === "agent-loop/task-1")).toBe(false);
  });
});

describe("CommandRunner", () => {
  it("records success and non-zero exit codes with the observed commit", async () => {
    const root = repository();
    const runner = new CommandRunner();
    const success = await runner.run({
      argv: [process.execPath, "-e", "console.log('ok')"],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "success"),
    });
    expect(success.exitCode).toBe(0);
    expect(success.commitBefore).toBe(new GitService(root).head());
    expect(readFileSync(success.stdoutPath, "utf8")).toContain("ok");

    const failure = await runner.run({
      argv: [process.execPath, "-e", "console.error('bad'); process.exit(7)"],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "failure"),
    });
    expect(failure.exitCode).toBe(7);
    expect(readFileSync(failure.stderrPath, "utf8")).toContain("bad");
  });

  it("times out and bounds captured output", async () => {
    const root = repository();
    mkdirSync(join(root, ".artifacts"), { recursive: true });
    const runner = new CommandRunner();
    const bounded = await runner.run({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "bounded"),
      outputLimitBytes: 128,
    });
    expect(readFileSync(bounded.stdoutPath)).toHaveLength(128);
    expect(bounded.stdoutTruncated).toBe(true);

    const timed = await runner.run({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "timeout"),
      timeoutMs: 100,
    });
    expect(timed.timedOut).toBe(true);
    expect(timed.exitCode === null || timed.exitCode !== 0).toBe(true);
  });

  it("rejects environment values outside the allowlist", async () => {
    const root = repository();
    await expect(
      new CommandRunner().run({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        artifactDirectory: join(root, ".artifacts", "env"),
        environment: { SECRET: "do-not-pass" },
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("does not interpret shell syntax unless shell mode is explicit", async () => {
    const root = repository();
    const runner = new CommandRunner();
    const result = await runner.run({
      argv: [process.execPath, "-e", "console.log(process.argv[1])", "value; echo injected"],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "no-shell"),
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, "utf8").trim()).toBe("value; echo injected");
  });

  it("validates timeout and output bounds", async () => {
    const root = repository();
    const base = {
      argv: [process.execPath, "-e", "process.exit(0)"] as [string, ...string[]],
      cwd: root,
      artifactDirectory: join(root, ".artifacts", "invalid"),
    };
    await expect(new CommandRunner().run({ ...base, timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    await expect(new CommandRunner().run({ ...base, outputLimitBytes: -1 })).rejects.toThrow("outputLimitBytes");
  });
});
