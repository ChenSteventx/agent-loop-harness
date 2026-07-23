import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandRunner,
  GitService,
  WorktreeService,
  commandReceiptProvesSuccess,
} from "../src/execution.js";
import type { CommandRequest } from "../src/execution.js";
import { fakeOciImage, fakeOciRunnerOptions, fakeOciRuntime } from "./oci-fixture.js";

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

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function commandRunner(tracePath?: string): CommandRunner {
  return new CommandRunner(fakeOciRunnerOptions(temporaryDirectory("agent-loop-fake-oci-state-"), tracePath));
}

function commandRunnerWithOptions(options: {
  dependencyRoot?: string;
  tracePath?: string;
}): CommandRunner {
  return new CommandRunner({
    ...fakeOciRunnerOptions(temporaryDirectory("agent-loop-fake-oci-state-"), options.tracePath),
    dependencyRoot: options.dependencyRoot,
  });
}

function artifactDirectory(label: string): string {
  return join(temporaryDirectory("agent-loop-command-artifacts-"), label);
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

  it("creates a deterministic Harness-owned candidate and rejects a Provider-staged index", () => {
    const root = repository();
    const service = new GitService(root);
    const baseCommit = service.head();
    writeFileSync(join(root, "tracked.txt"), "candidate\n");
    const candidate = service.commitCandidate({ baseCommit, message: "agent-loop(T): checkpoint 1" });
    expect(candidate).toMatchObject({
      baseCommit,
      commitSha: service.head(),
      diffHash: service.diffHashBetween(baseCommit),
      authorName: "Agent Loop Harness",
      authorEmail: "agent-loop@localhost",
    });
    expect(service.parent()).toBe(baseCommit);
    expect(service.isDirty()).toBe(false);
    expect(git(root, ["show", "-s", "--format=%an <%ae>", "HEAD"]).trim()).toBe(
      "Agent Loop Harness <agent-loop@localhost>",
    );

    writeFileSync(join(root, "tracked.txt"), "provider staged\n");
    git(root, ["add", "tracked.txt"]);
    expect(() => service.commitCandidate({
      baseCommit: service.head(), message: "must not commit",
    })).toThrow("only the Harness may stage");
  }, 20_000);

  it("scopes the control hash to the current worktree", () => {
    const root = repository();
    const other = join(root, "..", `unrelated-worktree-${Date.now()}`);
    temporaryDirectories.push(other);
    git(root, ["worktree", "add", "-b", "unrelated", other]);
    const service = new GitService(root);
    const originalHead = service.head();
    const initial = service.controlStateHash();

    git(other, ["commit", "--allow-empty", "-m", "unrelated worktree commit"]);
    expect(service.controlStateHash()).toBe(initial);

    git(root, ["commit", "--allow-empty", "-m", "current worktree control change"]);
    git(root, ["reset", "--hard", originalHead]);
    expect(service.head()).toBe(originalHead);
    expect(service.controlStateHash()).not.toBe(initial);

    git(root, ["worktree", "remove", "--force", other]);
  }, 20_000);
});

describe("CommandRunner", () => {
  it("records a v2 contained receipt for success and non-zero exit codes", async () => {
    const root = repository();
    const runner = commandRunner();
    const successRequest: CommandRequest = {
      argv: ["node", "-e", "console.log('ok')"],
      cwd: root,
      artifactDirectory: artifactDirectory("success"),
    };
    const expectation = runner.receiptExpectation(successRequest);
    const success = await runner.run(successRequest);
    expect(success.exitCode).toBe(0);
    expect(success.commitBefore).toBe(new GitService(root).head());
    expect(success).toMatchObject({
      schemaVersion: 2,
      sourceCommit: success.commitBefore,
      containmentOutcome: "exited",
      snapshotScopeVersion: "git-tree/v1",
      snapshotHashAfter: success.snapshotHashBefore,
      formalCommitAfter: success.commitBefore,
      formalDirtyAfter: false,
    });
    expect(success.sourceTree).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(success.commandSpecHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(success.sandboxPolicyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(success.stdoutHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(success.stderrHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(success.artifactManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(success.stdoutPath, "utf8")).toContain("ok");
    expect(commandReceiptProvesSuccess(success, expectation)).toBe(true);
    expect(commandReceiptProvesSuccess({ ...success, formalDirtyAfter: true }, expectation)).toBe(false);
    expect(commandReceiptProvesSuccess({ ...success, snapshotHashAfter: "f".repeat(64) }, expectation)).toBe(false);

    const failure = await runner.run({
      argv: ["node", "-e", "console.error('bad'); process.exit(7)"],
      cwd: root,
      artifactDirectory: artifactDirectory("failure"),
    });
    expect(failure.exitCode).toBe(7);
    expect(failure.containmentOutcome).toBe("exited");
    expect(readFileSync(failure.stderrPath, "utf8")).toContain("bad");
  }, 20_000);

  it("bounds captured output", async () => {
    const root = repository();
    const runner = commandRunner();
    const bounded = await runner.run({
      argv: ["node", "-e", "process.stdout.write('x'.repeat(10000))"],
      cwd: root,
      artifactDirectory: artifactDirectory("bounded"),
      outputLimitBytes: 128,
    });
    expect(readFileSync(bounded.stdoutPath)).toHaveLength(128);
    expect(bounded.stdoutTruncated).toBe(true);
  });

  it("times out the whole contained command", async () => {
    const root = repository();
    const runner = commandRunner();
    const timed = await runner.run({
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      artifactDirectory: artifactDirectory("timeout"),
      timeoutMs: 100,
    });
    expect(timed.timedOut).toBe(true);
    expect(timed.exitCode === null || timed.exitCode !== 0).toBe(true);
    expect(["killed", "unconfirmed"]).toContain(timed.containmentOutcome);
  });

  it("rejects environment values outside the allowlist", async () => {
    const root = repository();
    await expect(
      commandRunner().run({
        argv: ["node", "-e", "process.exit(0)"],
        cwd: root,
        artifactDirectory: artifactDirectory("env"),
        environment: { SECRET: "do-not-pass" },
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("does not interpret shell syntax unless shell mode is explicit", async () => {
    const root = repository();
    const runner = commandRunner();
    const result = await runner.run({
      argv: ["node", "-e", "console.log(process.argv[1])", "value; echo injected"],
      cwd: root,
      artifactDirectory: artifactDirectory("no-shell"),
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, "utf8").trim()).toBe("value; echo injected");
  });

  it("validates timeout and output bounds", async () => {
    const root = repository();
    const base = {
      argv: ["node", "-e", "process.exit(0)"] as [string, ...string[]],
      cwd: root,
      artifactDirectory: artifactDirectory("invalid"),
    };
    const runner = commandRunner();
    await expect(runner.run({ ...base, timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    await expect(runner.run({ ...base, outputLimitBytes: -1 })).rejects.toThrow("outputLimitBytes");
  });

  it("fails closed when no OCI runtime and immutable image are configured", async () => {
    const root = repository();
    await expect(new CommandRunner({ controlEnvironment: {} }).run({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: artifactDirectory("unconfigured"),
    })).rejects.toThrow("OCI containment is not configured");
  });

  it("does not authorize exit zero when the disposable workspace changes", async () => {
    const root = repository();
    const original = readFileSync(join(root, "tracked.txt"), "utf8");
    const result = await commandRunner().run({
      argv: ["node", "-e", "require('node:fs').writeFileSync('tracked.txt', 'mutated\\n')"],
      cwd: root,
      artifactDirectory: artifactDirectory("workspace-mutation"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.snapshotHashAfter).not.toBe(result.snapshotHashBefore);
    expect(result.containmentOutcome).toBe("workspace-mutated");
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe(original);
    expect(new GitService(root).isDirty()).toBe(false);
  });

  it("materializes every raw Git blob even when export-ignore is repository-controlled", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitattributes"), "hidden.txt export-ignore\n");
    writeFileSync(join(root, "hidden.txt"), "must remain in the verification snapshot\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add export-ignore fixture"]);
    const result = await commandRunner().run({
      argv: ["node", "-e", "console.log(require('node:fs').existsSync('hidden.txt'))"],
      cwd: root,
      artifactDirectory: artifactDirectory("raw-tree"),
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, "utf8").trim()).toBe("true");
  });

  it("materializes the committed blob while repository replace refs are active", async () => {
    const root = repository();
    const replacementPath = join(temporaryDirectory("agent-loop-replacement-"), "tracked.txt");
    writeFileSync(replacementPath, "forged replacement\n");
    const originalBlob = git(root, ["rev-parse", "HEAD:tracked.txt"]).trim();
    const replacementBlob = git(root, ["hash-object", "-w", replacementPath]).trim();
    git(root, ["replace", originalBlob, replacementBlob]);

    const result = await commandRunner().run({
      argv: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('tracked.txt','utf8'))"],
      cwd: root,
      artifactDirectory: artifactDirectory("replace-ref"),
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, "utf8")).toBe("one\n");
  });

  it("strips ambient Git repository selectors from every formal Git read", async () => {
    const root = repository();
    const decoy = repository();
    writeFileSync(join(decoy, "tracked.txt"), "decoy\n");
    git(decoy, ["add", "."]);
    git(decoy, ["commit", "-m", "decoy state"]);
    const stateDirectory = temporaryDirectory("agent-loop-fake-oci-state-");
    const base = fakeOciRunnerOptions(stateDirectory);
    const runner = new CommandRunner({
      ...base,
      controlEnvironment: {
        ...base.controlEnvironment,
        GIT_DIR: join(decoy, ".git"),
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoy, ".git", "index"),
        GIT_OBJECT_DIRECTORY: join(decoy, ".git", "objects"),
        GIT_CONFIG_GLOBAL: join(decoy, "poisoned-global-config"),
      },
    });

    const result = await runner.run({
      argv: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('tracked.txt','utf8'))"],
      cwd: root,
      artifactDirectory: artifactDirectory("git-environment"),
    });

    expect(result.commitBefore).toBe(git(root, ["rev-parse", "HEAD"]).trim());
    expect(readFileSync(result.stdoutPath, "utf8")).toBe("one\n");
  });

  it("keeps using the Git executable bound before PATH changes", async () => {
    const root = repository();
    const runner = commandRunner();
    const originalPath = process.env.PATH;
    process.env.PATH = temporaryDirectory("agent-loop-poison-path-");
    try {
      const result = await runner.run({
        argv: ["node", "-e", "process.exit(0)"],
        cwd: root,
        artifactDirectory: artifactDirectory("bound-git"),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it.runIf(process.platform !== "win32")("rejects a runtime executable changed after its content was bound", () => {
    const root = repository();
    const runtimePath = join(temporaryDirectory("agent-loop-runtime-identity-"), "fake-runtime.mjs");
    writeFileSync(runtimePath, readFileSync(fakeOciRuntime), { mode: 0o755 });
    chmodSync(runtimePath, 0o755);
    const runner = new CommandRunner({
      runtime: { engine: "docker", executable: runtimePath },
      imageDigest: fakeOciImage,
      controlEnvironment: {
        ...process.env,
        AGENT_LOOP_FAKE_OCI_STATE: temporaryDirectory("agent-loop-runtime-identity-state-"),
      },
    });
    const request: CommandRequest = {
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: artifactDirectory("runtime-identity"),
    };
    runner.receiptExpectation(request);

    writeFileSync(runtimePath, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    chmodSync(runtimePath, 0o755);

    expect(() => runner.receiptExpectation(request)).toThrow("runtime executable content changed");
  });

  it.runIf(process.platform !== "win32")("rejects an artifact path through a repository symlink before creating it", async () => {
    const root = repository();
    const link = join(temporaryDirectory("agent-loop-artifact-parent-"), "repository-link");
    symlinkSync(root, link, "dir");
    const requested = join(link, "must-not-exist", "artifacts");

    await expect(commandRunner().run({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: requested,
    })).rejects.toThrow("artifactDirectory must be outside the formal repository");
    expect(existsSync(join(root, "must-not-exist"))).toBe(false);
  });

  it("keeps SUT-created artifact symlinks away from host receipt writes", async () => {
    const root = repository();
    const artifacts = artifactDirectory("artifact-symlink");
    const result = await commandRunner().run({
      argv: ["node", "-e", [
        "const fs=require('node:fs'),p=require('node:path')",
        "fs.symlinkSync('../escaped.txt',p.join(process.env.ARTIFACT_DIR,'stdout.log'))",
        "console.log('receipt stays separate')",
      ].join(";")],
      cwd: root,
      artifactDirectory: artifacts,
      environmentAllowlist: ["ARTIFACT_DIR"],
      environment: { ARTIFACT_DIR: "/artifacts" },
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, "utf8")).toContain("receipt stays separate");
    expect(existsSync(join(artifacts, "escaped.txt"))).toBe(false);
  });

  it("exports bounded tmpfs artifacts after exit and removes the retained container", async () => {
    const root = repository();
    const artifacts = artifactDirectory("bounded-artifact-export");
    const stateDirectory = temporaryDirectory("agent-loop-artifact-state-");
    const tracePath = join(temporaryDirectory("agent-loop-artifact-trace-"), "trace.jsonl");
    const runner = new CommandRunner({
      ...fakeOciRunnerOptions(stateDirectory, tracePath),
      artifactByteLimit: 64,
      artifactFileLimit: 2,
    });
    const result = await runner.run({
      argv: ["node", "-e", "require('node:fs').writeFileSync(process.env.RESULT_PATH,'proof')"],
      cwd: root,
      artifactDirectory: artifacts,
      environmentAllowlist: ["RESULT_PATH"],
      environment: { RESULT_PATH: "/artifacts/result.txt" },
    });

    expect(result.containmentOutcome).toBe("exited");
    const exported = readdirSync(artifacts, { recursive: true })
      .map(String)
      .find((path) => path.endsWith("result.txt"));
    expect(exported).toBeDefined();
    expect(readFileSync(join(artifacts, exported!), "utf8")).toBe("proof");
    expect(readdirSync(stateDirectory)).toEqual([]);
    const trace = JSON.parse(readFileSync(tracePath, "utf8").trim()) as { args: string[] };
    expect(trace.args).toContain("/artifacts:rw,noexec,nosuid,nodev,size=64,nr_inodes=2,mode=1777");
  });

  it("kills detached descendants with the timed-out container", async () => {
    const root = repository();
    const artifacts = artifactDirectory("detached-descendant");
    const result = await commandRunner().run({
      argv: ["node", "-e", [
        "const {spawn}=require('node:child_process')",
        "const code=\"setTimeout(()=>require('node:fs').writeFileSync(process.env.MARKER,'late'),500)\"",
        "spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore',env:process.env}).unref()",
        "setInterval(()=>{},1000)",
      ].join(";")],
      cwd: root,
      artifactDirectory: artifacts,
      environmentAllowlist: ["MARKER"],
      environment: { MARKER: "/artifacts/late.txt" },
      timeoutMs: 100,
      terminationGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.containmentOutcome).toBe("killed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    expect(readdirSync(artifacts, { recursive: true }).some((path) => String(path).endsWith("late.txt"))).toBe(false);
  });

  it("reaps a container that appears after the first timeout cleanup attempt", async () => {
    const root = repository();
    const artifacts = artifactDirectory("delayed-container");
    const stateDirectory = temporaryDirectory("agent-loop-delayed-oci-state-");
    const base = fakeOciRunnerOptions(stateDirectory);
    const runner = new CommandRunner({
      ...base,
      controlEnvironment: {
        ...base.controlEnvironment,
        AGENT_LOOP_FAKE_OCI_DELAYED_CREATE_MS: "300",
      },
    });
    const result = await runner.run({
      argv: ["node", "-e", "setTimeout(()=>require('node:fs').writeFileSync(process.env.MARKER,'late'),900)"],
      cwd: root,
      artifactDirectory: artifacts,
      environmentAllowlist: ["MARKER"],
      environment: { MARKER: "/artifacts/late.txt" },
      timeoutMs: 100,
      terminationGraceMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.containmentOutcome).toBe("killed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(readdirSync(artifacts, { recursive: true }).some((path) => String(path).endsWith("late.txt"))).toBe(false);
  }, 10_000);

  it("does not equate an inspect error with absence while timeout cleanup is still denied", async () => {
    const root = repository();
    const stateDirectory = temporaryDirectory("agent-loop-ambiguous-inspect-state-");
    const base = fakeOciRunnerOptions(stateDirectory);
    const runner = new CommandRunner({
      ...base,
      controlEnvironment: {
        ...base.controlEnvironment,
        AGENT_LOOP_FAKE_OCI_INSPECT_ERROR: "1",
        AGENT_LOOP_FAKE_OCI_RM_DELAY_MS: "1500",
      },
    });
    const started = Date.now();
    const result = await runner.run({
      argv: ["node", "-e", "setInterval(()=>{},1000)"],
      cwd: root,
      artifactDirectory: artifactDirectory("ambiguous-inspect"),
      timeoutMs: 100,
      terminationGraceMs: 100,
    });

    expect(result.containmentOutcome).toBe("killed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(readdirSync(stateDirectory)).toEqual([]);
  }, 10_000);

  it("passes only explicit environment values and emits the fixed isolation policy", async () => {
    const root = repository();
    const tracePath = join(temporaryDirectory("agent-loop-oci-trace-"), "trace.jsonl");
    const result = await commandRunner(tracePath).run({
      argv: ["node", "-e", "console.log(process.env.SAFE, process.env.SECRET ?? 'missing')"],
      cwd: root,
      artifactDirectory: artifactDirectory("environment"),
      environmentAllowlist: ["SAFE"],
      environment: { SAFE: "allowed" },
    });
    expect(readFileSync(result.stdoutPath, "utf8").trim()).toBe("allowed missing");
    const trace = JSON.parse(readFileSync(tracePath, "utf8").trim()) as { args: string[] };
    expect(trace.args).toEqual(expect.arrayContaining([
      "--network", "none", "--ipc", "none", "--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges",
      "--no-healthcheck", "--memory", "512m", "--memory-swap", "512m", "--entrypoint", "node",
    ]));
    const mounts = trace.args.filter((value) => value.startsWith("type=bind,"));
    expect(mounts).toHaveLength(1);
    expect(mounts.some((value) => value.includes("dst=/workspace") && value.includes("readonly"))).toBe(true);
    expect(trace.args).toContain("/artifacts:rw,noexec,nosuid,nodev,size=67108864,nr_inodes=1000,mode=1777");
  });

  it("disables Podman's implicit writable tmpfs and image volumes", async () => {
    const root = repository();
    const tracePath = join(temporaryDirectory("agent-loop-podman-trace-"), "trace.jsonl");
    const base = fakeOciRunnerOptions(temporaryDirectory("agent-loop-fake-podman-state-"), tracePath);
    const runner = new CommandRunner({
      ...base,
      runtime: { ...base.runtime!, engine: "podman" },
    });
    const result = await runner.run({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: artifactDirectory("podman-policy"),
    });

    expect(result.exitCode).toBe(0);
    const trace = JSON.parse(readFileSync(tracePath, "utf8").trim()) as { args: string[]; forcedLocal: boolean };
    expect(trace.forcedLocal).toBe(true);
    expect(trace.args).toEqual(expect.arrayContaining([
      "--read-only-tmpfs=false",
      "--image-volume=ignore",
      "--ipc", "private",
    ]));
    expect(trace.args.some((value) => value.includes("nr_inodes="))).toBe(false);
    expect(trace.args).toContain("/artifacts:rw,noexec,nosuid,nodev,size=67108864,mode=1777");
  });

  it("accepts only a content-addressed dependency child and mounts it read-only", async () => {
    const root = repository();
    const dependencyRoot = temporaryDirectory("agent-loop-dependencies-");
    const emptyDirectoryHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const dependencyPath = join(dependencyRoot, emptyDirectoryHash);
    mkdirSync(dependencyPath);
    const tracePath = join(temporaryDirectory("agent-loop-oci-trace-"), "trace.jsonl");
    const result = await commandRunnerWithOptions({ dependencyRoot, tracePath }).run({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: artifactDirectory("dependency"),
      dependencyInput: { path: dependencyPath, contentHash: emptyDirectoryHash },
    });
    expect(result.dependencyInputHash).toBe(emptyDirectoryHash);
    const trace = JSON.parse(readFileSync(tracePath, "utf8").trim()) as { args: string[] };
    const dependencyMount = trace.args.find((value) => value.includes("dst=/dependencies"));
    expect(dependencyMount).toContain("type=bind,src=");
    expect(dependencyMount).toContain(",dst=/dependencies,readonly");
    expect(dependencyMount).not.toContain(dependencyPath);

    await expect(commandRunnerWithOptions({ dependencyRoot }).run({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: root,
      artifactDirectory: artifactDirectory("bad-dependency"),
      dependencyInput: { path: dependencyPath, contentHash: "0".repeat(64) },
    })).rejects.toThrow("named by its sha256 content hash");
  });

  it("mounts a private dependency snapshot rather than the live content-addressed directory", async () => {
    const root = repository();
    const dependencyRoot = temporaryDirectory("agent-loop-live-dependencies-");
    const emptyDirectoryHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const dependencyPath = join(dependencyRoot, emptyDirectoryHash);
    mkdirSync(dependencyPath);
    const runner = commandRunnerWithOptions({ dependencyRoot });
    const running = runner.run({
      argv: ["node", "-e", [
        "setTimeout(()=>console.log(require('node:fs').existsSync(process.env.DEPENDENCY_PROBE)),300)",
      ].join(";")],
      cwd: root,
      artifactDirectory: artifactDirectory("dependency-snapshot"),
      dependencyInput: { path: dependencyPath, contentHash: emptyDirectoryHash },
      environmentAllowlist: ["DEPENDENCY_PROBE"],
      environment: { DEPENDENCY_PROBE: "/dependencies/injected.txt" },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    writeFileSync(join(dependencyPath, "injected.txt"), "late mutation\n");
    const result = await running;

    expect(result.exitCode).toBe(0);
    expect(result.containmentOutcome).toBe("exited");
    expect(readFileSync(result.stdoutPath, "utf8").trim()).toBe("false");
  });
});
