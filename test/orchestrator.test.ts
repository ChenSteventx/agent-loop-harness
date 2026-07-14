import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { GenericNodeProjectAdapter } from "../src/project.js";
import type {
  ProviderAdapter,
  ProviderProbe,
  ProviderRunRequest,
  ProviderRunResult,
} from "../src/provider.js";
import type { ProjectAdapter } from "../src/ports.js";

const temporaryDirectories: string[] = [];

function targetRepository(
  failingCheck = false,
  risk: "low" | "normal" | "high" | "unknown" = "low",
): { root: string; taskPath: string; schemaPath: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-target-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "agent-loop@example.invalid"]);
  git(root, ["config", "user.name", "Agent Loop Test"]);
  writeFileSync(
    join(root, "check.mjs"),
    failingCheck
      ? "process.stderr.write('verification failed\\n'); process.exit(3);\n"
      : "import { existsSync } from 'node:fs'; process.exit(existsSync('changed.txt') ? 0 : 4);\n",
  );
  const taskPath = join(root, "task.yaml");
  writeFileSync(
    taskPath,
    [
      "id: TASK-1",
      "goal: Add the requested file",
      "acceptance:",
      "  - changed.txt exists",
      `risk: ${risk}`,
      "verification:",
      "  - id: check",
      "    argv: [node, check.mjs]",
      "",
    ].join("\n"),
  );
  const schemaPath = join(root, "schema.json");
  writeFileSync(schemaPath, JSON.stringify({ type: "object" }));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { root, taskPath, schemaPath };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class FakeAuthor implements ProviderAdapter {
  calls = 0;
  requests: ProviderRunRequest[] = [];

  constructor(private readonly succeeds = true) {}

  async probe(): Promise<ProviderProbe> {
    return {
      available: true,
      identity: { provider: "fake", model: "fixture", executable: "in-process", version: "1" },
      error: null,
    };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.calls += 1;
    this.requests.push(request);
    mkdirSync(request.artifactDirectory, { recursive: true });
    const identity = { provider: "fake", model: "fixture", executable: "in-process", version: "1" };
    const explorer = request.workspaceAccess === "read-only";
    if (this.succeeds && !explorer) {
      writeFileSync(join(request.cwd, "changed.txt"), "created by fake author\n");
    }
    const result: ProviderRunResult = {
      invocationId: request.invocationId,
      ok: this.succeeds,
      cancelled: false,
      identity,
      threadId: "fake-thread",
      events: [{ type: "thread.started", thread_id: "fake-thread" }],
      finalOutput: this.succeeds
        ? explorer
          ? {
              relevantFiles: [{ path: "check.mjs", symbols: [] }],
              likelyAffectedTests: ["check.mjs"],
              evidence: [{ path: "task.yaml", observation: "Acceptance requires changed.txt" }],
              importantUnknowns: [],
            }
          : { summary: "Added the requested file", changedFiles: ["changed.txt"] }
        : null,
      stderr: this.succeeds ? "" : "fixture author failure",
      exitCode: this.succeeds ? 0 : 1,
      signal: null,
      durationMs: 1,
      usage: null,
      failureClass: this.succeeds ? null : "unknown",
      eventsPath: join(request.artifactDirectory, "events.jsonl"),
      finalOutputPath: join(request.artifactDirectory, "final.json"),
      stderrPath: join(request.artifactDirectory, "stderr.log"),
    };
    writeFileSync(result.eventsPath, `${JSON.stringify(result.events[0])}\n`);
    writeFileSync(result.finalOutputPath, JSON.stringify(result.finalOutput));
    writeFileSync(result.stderrPath, result.stderr);
    return result;
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

class CommittingAuthor extends FakeAuthor {
  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await super.run(request);
    if (request.workspaceAccess !== "read-only") {
      git(request.cwd, ["add", "changed.txt"]);
      git(request.cwd, ["commit", "-m", "malicious provider commit"]);
    }
    return result;
  }
}

class WritingExplorer extends FakeAuthor {
  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    if (request.workspaceAccess === "read-only") {
      writeFileSync(join(request.cwd, "forbidden.txt"), "attempted explorer write\n");
    }
    return super.run(request);
  }
}

function createOrchestrator(
  fixture: ReturnType<typeof targetRepository>,
  provider: ProviderAdapter,
  projectAdapter: ProjectAdapter = new GenericNodeProjectAdapter(),
  faults?: { afterProviderCompletion?: () => void; afterHarnessCommit?: () => void },
): Orchestrator {
  const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
  temporaryDirectories.push(loopHome);
  return new Orchestrator({
    loopHome,
    provider,
    projectAdapter,
    outputSchemaPath: fixture.schemaPath,
    faults,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Orchestrator", () => {
  it("moves a Fake Provider patch from open to ready with real command evidence", async () => {
    const fixture = targetRepository();
    const provider = new FakeAuthor();
    const orchestrator = createOrchestrator(fixture, provider);
    const view = await orchestrator.start({
      runId: "run-ready",
      taskPath: fixture.taskPath,
      targetRepository: fixture.root,
    });

    expect(view.run.status).toBe("ready");
    expect(view.worktreePath).not.toBe(fixture.root);
    expect(provider.requests[0]).toMatchObject({
      workspaceAccess: "workspace-write",
      allowedRepositoryRoots: [view.worktreePath],
    });
    expect(provider.requests[0]?.additionalWritableDirectories).toBeUndefined();
    expect(view.evidence.map((item) => item.kind)).toEqual(["candidate_commit", "command"]);
    expect((view.evidence.find((item) => item.kind === "command")?.data as { exitCode: number }).exitCode).toBe(0);
    expect(view.operations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(git(view.worktreePath, ["show", "-s", "--format=%an <%ae>", "HEAD"])).toBe(
      "Agent Loop Harness <agent-loop@localhost>",
    );
    orchestrator.close();
  }, 20_000);

  it("does not become ready after failed or missing verification", async () => {
    const failingFixture = targetRepository(true);
    const failing = createOrchestrator(failingFixture, new FakeAuthor());
    expect(
      (await failing.start({ runId: "run-failed", taskPath: failingFixture.taskPath, targetRepository: failingFixture.root }))
        .run.status,
    ).toBe("blocked");
    failing.close();

    const missingFixture = targetRepository();
    const emptyAdapter: ProjectAdapter = {
      name: "empty",
      policyVersion: "empty/v1",
      verificationCommands: () => [],
      postMergeCommands: () => [],
    };
    const missing = createOrchestrator(missingFixture, new FakeAuthor(), emptyAdapter);
    const missingView = await missing.start({
      runId: "run-missing",
      taskPath: missingFixture.taskPath,
      targetRepository: missingFixture.root,
    });
    expect(missingView.run.status).toBe("blocked");
    expect(missingView.evidence.map((item) => item.kind)).toEqual(["candidate_commit"]);
    missing.close();
  }, 20_000);

  it("fails closed at ready when risk is unknown", async () => {
    const fixture = targetRepository(false, "unknown");
    const orchestrator = createOrchestrator(fixture, new FakeAuthor());
    const view = await orchestrator.start({
      runId: "run-unknown-risk",
      taskPath: fixture.taskPath,
      targetRepository: fixture.root,
    });

    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked).toMatchObject({
      previousStatus: "open",
      checkpointRef: "risk-classification",
    });
    expect(view.evidence).toHaveLength(2);
    orchestrator.close();
  }, 20_000);

  it("runs a bounded Explorer for assisted work and gives the Author only its compact report", async () => {
    const fixture = targetRepository(false, "normal");
    const provider = new FakeAuthor();
    const orchestrator = createOrchestrator(fixture, provider);
    const view = await orchestrator.start({
      runId: "run-assisted", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });

    expect(view.run.status).toBe("ready");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({
      workspaceAccess: "read-only",
      contextBudget: 8000,
    });
    expect(provider.requests[0]?.allowedRepositoryRoots).toEqual([view.worktreePath]);
    expect(provider.requests[0]?.additionalWritableDirectories).toBeUndefined();
    expect(provider.requests[0]?.outputSchemaPath).toMatch(/explorer-output\.schema\.json$/u);
    expect(provider.requests[1]?.outputSchemaPath).toMatch(/author-output\.schema\.json$/u);
    expect(provider.requests.some((request) => request.outputSchemaPath.includes("automation"))).toBe(false);
    expect(provider.requests[1]?.prompt).toContain("Explorer advisory report:");
    expect(provider.requests[1]?.prompt).not.toContain("thread.started");
    expect(view.operations[0]).toMatchObject({ kind: "explorer", status: "succeeded" });
    expect(view.operations[0]?.result).toMatchObject({ costTokens: 0, latencyMs: 1, used: true });
    orchestrator.close();
  }, 20_000);

  it("rejects an attempted Explorer write at the Harness boundary without changing Run state", async () => {
    const fixture = targetRepository(false, "normal");
    const orchestrator = createOrchestrator(fixture, new WritingExplorer());

    await expect(orchestrator.start({
      runId: "run-explorer-write", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("read-only workspace boundary");
    const view = orchestrator.status("run-explorer-write");
    expect(view.run.status).toBe("open");
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0]).toMatchObject({ kind: "explorer", status: "failed" });
    orchestrator.close();
  }, 20_000);

  it("keeps useful durable status when the Author fails", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new FakeAuthor(false));
    await orchestrator.start({ runId: "run-interrupted", taskPath: fixture.taskPath, targetRepository: fixture.root });
    const status = orchestrator.status("run-interrupted");
    expect(status.run.status).toBe("blocked");
    expect(status.run.blocked?.resumeCommand).toContain("run-interrupted");
    expect(status.operations[0]).toMatchObject({ kind: "author", status: "failed" });
    expect(status.events.some((event) => event.type === "worktree.created")).toBe(true);
    orchestrator.close();
  }, 20_000);

  it("rejects a Provider-created commit and never grants the Git common directory", async () => {
    const fixture = targetRepository();
    const provider = new CommittingAuthor();
    const orchestrator = createOrchestrator(fixture, provider);
    const view = await orchestrator.start({
      runId: "run-provider-commit", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("only the Harness may commit");
    expect(view.operations.map((operation) => operation.kind)).toEqual(["author"]);
    expect(provider.requests[0]?.additionalWritableDirectories).toBeUndefined();
    orchestrator.close();
  }, 20_000);

  it("records only a real supplied merge commit", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new FakeAuthor());
    const ready = await orchestrator.start({
      runId: "run-merge",
      taskPath: fixture.taskPath,
      targetRepository: fixture.root,
    });
    const authoredSha = git(ready.worktreePath, ["rev-parse", "HEAD"]);
    expect(() => orchestrator.markMerged("run-merge", fixture.root, "deadbeef")).toThrow("not a commit");
    expect(() => orchestrator.markMerged("run-merge", fixture.root, authoredSha)).toThrow("current HEAD");
    git(fixture.root, ["merge", "--ff-only", "agent-loop/TASK-1-run-merge"]);
    expect(orchestrator.markMerged("run-merge", fixture.root, authoredSha).run).toMatchObject({
      status: "merged",
      mergeSha: authoredSha,
    });
    orchestrator.close();
  }, 20_000);

  it("recovers a crash after provider completion without invoking the Author again", async () => {
    const fixture = targetRepository();
    const provider = new FakeAuthor();
    const orchestrator = createOrchestrator(fixture, provider, new GenericNodeProjectAdapter(), {
      afterProviderCompletion: () => {
        throw new Error("simulated crash after provider completion");
      },
    });
    await expect(
      orchestrator.start({ runId: "run-crash", taskPath: fixture.taskPath, targetRepository: fixture.root }),
    ).rejects.toThrow("simulated crash");
    expect(orchestrator.status("run-crash").operations[0]?.status).toBe("running");

    const resumed = await orchestrator.resume("run-crash");
    expect(resumed.run.status).toBe("ready");
    expect(provider.calls).toBe(1);
    expect(resumed.events.some((event) => event.type === "author.recovered")).toBe(true);
    const counts = [resumed.operations.length, resumed.evidence.length, resumed.events.length];
    const repeated = await orchestrator.resume("run-crash");
    expect([repeated.operations.length, repeated.evidence.length, repeated.events.length]).toEqual(counts);
    orchestrator.close();
  }, 20_000);

  it("recovers a crash after the Harness commit without invoking the Author again", async () => {
    const fixture = targetRepository();
    const provider = new FakeAuthor();
    let crash = true;
    const orchestrator = createOrchestrator(fixture, provider, new GenericNodeProjectAdapter(), {
      afterHarnessCommit: () => {
        if (crash) {
          crash = false;
          throw new Error("simulated crash after Harness commit");
        }
      },
    });
    await expect(orchestrator.start({
      runId: "run-commit-crash", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("simulated crash after Harness commit");
    expect(orchestrator.status("run-commit-crash").operations.at(-1)).toMatchObject({
      kind: "checkpoint-commit", status: "running",
    });

    const resumed = await orchestrator.resume("run-commit-crash");
    expect(resumed.run.status).toBe("ready");
    expect(provider.calls).toBe(1);
    expect(resumed.events.some((event) => event.type === "candidate-commit.recovered")).toBe(true);
    orchestrator.close();
  }, 20_000);

  it("invalidates Evidence and blocks if an external actor replaces the Harness candidate", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new FakeAuthor());
    const ready = await orchestrator.start({
      runId: "run-invalidate",
      taskPath: fixture.taskPath,
      targetRepository: fixture.root,
    });
    writeFileSync(join(ready.worktreePath, "follow-up.txt"), "new committed state\n");
    git(ready.worktreePath, ["add", "follow-up.txt"]);
    git(ready.worktreePath, ["commit", "-m", "test: change evidence dependency"]);

    const blocked = await orchestrator.resume("run-invalidate");
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.blocked?.reason).toContain("candidate commit");
    expect(blocked.evidence.every((item) => item.status === "invalid")).toBe(true);
    orchestrator.close();
  }, 20_000);

  it("resumes from the saved task snapshot and fails closed if the task source is rebound", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new FakeAuthor());
    const ready = await orchestrator.start({
      runId: "run-bound", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(ready.run.binding).toMatchObject({
      taskSpecHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      acceptanceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      baselineCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      risk: "low",
      executionTemplate: "solo",
      projectAdapterName: "generic-node",
      policyVersion: "generic-node/v1",
    });
    expect((await orchestrator.resume("run-bound")).run.status).toBe("ready");

    const changedTask = readFileSync(fixture.taskPath, "utf8").replace(
      "  - changed.txt exists",
      "  - a different acceptance must hold",
    );
    writeFileSync(fixture.taskPath, changedTask);
    const blocked = await orchestrator.resume("run-bound");
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.blocked?.reason).toContain("task spec");
    expect(blocked.evidence.every((item) => item.status === "invalid")).toBe(true);
    orchestrator.close();
  }, 20_000);

  it("runs post-merge checks before done and preserves a failed merge fact", async () => {
    const fixture = targetRepository();
    const passing = createOrchestrator(fixture, new FakeAuthor());
    await passing.start({ runId: "run-done", taskPath: fixture.taskPath, targetRepository: fixture.root });
    git(fixture.root, ["merge", "--ff-only", "agent-loop/TASK-1-run-done"]);
    const mergeSha = git(fixture.root, ["rev-parse", "HEAD"]);
    passing.markMerged("run-done", fixture.root, mergeSha);
    const done = await passing.resume("run-done", fixture.taskPath);
    expect(done.run.status).toBe("done");
    expect(done.evidence.some((item) => item.stepId === "post-merge:check")).toBe(true);
    passing.close();

    const failingFixture = targetRepository();
    const base = new GenericNodeProjectAdapter();
    const failingPostMerge: ProjectAdapter = {
      name: "post-merge-failure",
      policyVersion: "post-merge-failure/v1",
      verificationCommands: (task) => base.verificationCommands(task),
      postMergeCommands: () => [{ id: "post-failure", argv: [process.execPath, "-e", "process.exit(9)"] }],
    };
    const failing = createOrchestrator(failingFixture, new FakeAuthor(), failingPostMerge);
    await failing.start({ runId: "run-remediate", taskPath: failingFixture.taskPath, targetRepository: failingFixture.root });
    git(failingFixture.root, ["merge", "--ff-only", "agent-loop/TASK-1-run-remediate"]);
    const failedMergeSha = git(failingFixture.root, ["rev-parse", "HEAD"]);
    failing.markMerged("run-remediate", failingFixture.root, failedMergeSha);
    const blocked = await failing.resume("run-remediate", failingFixture.taskPath);
    expect(blocked.run).toMatchObject({ status: "blocked", mergeSha: failedMergeSha });
    expect(blocked.run.blocked?.previousStatus).toBe("merged");
    const factCounts = [blocked.operations.length, blocked.evidence.length, blocked.events.length];
    const repeated = await failing.resume("run-remediate", failingFixture.taskPath);
    expect([repeated.operations.length, repeated.evidence.length, repeated.events.length]).toEqual(factCounts);
    expect(repeated.run).toMatchObject({ status: "blocked", mergeSha: failedMergeSha });
    failing.close();
  }, 30_000);
});

describe("CLI surface", () => {
  it("exposes all Phase 1 commands", () => {
    const result = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "--help"], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    for (const command of ["init", "run", "status", "resume", "verify", "mark-merged"]) {
      expect(result.stdout).toContain(command);
    }
  });
});
