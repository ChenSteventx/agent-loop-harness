import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRunner, type CommandRequest, type CommandResult } from "../src/execution.js";
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

function repairableRepository(): ReturnType<typeof targetRepository> {
  const fixture = targetRepository();
  writeFileSync(
    join(fixture.root, "check.mjs"),
    [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync('changed.txt', 'utf8').trim();",
      "if (value !== 'fixed') { process.stderr.write(`expected fixed, received ${value}\\n`); process.exit(3); }",
      "",
    ].join("\n"),
  );
  git(fixture.root, ["add", "check.mjs"]);
  git(fixture.root, ["commit", "--amend", "--no-edit"]);
  return fixture;
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

class RepairingAuthor extends FakeAuthor {
  constructor(private readonly repairSucceeds = true) {
    super();
  }

  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await super.run(request);
    if (request.workspaceAccess !== "read-only") {
      const repairing = request.prompt.includes("Role: bounded Repair attempt");
      writeFileSync(join(request.cwd, "changed.txt"), repairing && this.repairSucceeds ? "fixed\n" : "broken\n");
      if (repairing && !this.repairSucceeds) {
        writeFileSync(join(request.cwd, "repair-attempt.txt"), "ineffective repair\n");
      }
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

class SensitivePathAuthor extends FakeAuthor {
  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await super.run(request);
    if (request.workspaceAccess !== "read-only") {
      mkdirSync(join(request.cwd, "src", "security"), { recursive: true });
      writeFileSync(join(request.cwd, "src", "security", "policy.txt"), "sensitive change\n");
    }
    return result;
  }
}

class FailedResultAuthor extends FakeAuthor {
  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await super.run(request);
    return { ...result, ok: false, exitCode: 1, failureClass: "transient" };
  }
}

class CommitResetAuthor extends FakeAuthor {
  override async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await super.run(request);
    if (request.workspaceAccess !== "read-only") {
      git(request.cwd, ["add", "changed.txt"]);
      git(request.cwd, ["commit", "-m", "provider control-state mutation"]);
      git(request.cwd, ["reset", "--mixed", "HEAD^"]);
    }
    return result;
  }
}

class TimedOutSuccessRunner extends CommandRunner {
  override async run(request: CommandRequest): Promise<CommandResult> {
    mkdirSync(request.artifactDirectory, { recursive: true });
    const stdoutPath = join(request.artifactDirectory, "stdout.log");
    const stderrPath = join(request.artifactDirectory, "stderr.log");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "timed out after child reported zero\n");
    return {
      argv: request.argv,
      cwd: request.cwd,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: true,
      stdoutPath,
      stderrPath,
      stdoutTruncated: false,
      stderrTruncated: false,
      commitBefore: git(request.cwd, ["rev-parse", "HEAD"]),
    };
  }
}

function createOrchestrator(
  fixture: ReturnType<typeof targetRepository>,
  provider: ProviderAdapter,
  projectAdapter: ProjectAdapter = new GenericNodeProjectAdapter(),
  faults?: {
    afterProviderCompletion?: () => void;
    afterHarnessCommit?: () => void;
    afterVerificationFailure?: () => void;
    afterWriterOperationCreated?: (role: "author" | "repair") => void;
    afterCandidateEvidenceInstalled?: () => void;
    afterExplorerOperationCompleted?: () => void;
  },
): Orchestrator {
  const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
  temporaryDirectories.push(loopHome);
  return new Orchestrator({
    loopHome,
    provider,
    projectAdapter,
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
      minimumRisk: () => "low",
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
  }, 90_000);

  it("never treats a timed-out command with exit zero as successful Evidence", async () => {
    const fixture = targetRepository();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    const orchestrator = new Orchestrator({
      loopHome,
      provider: new FakeAuthor(),
      projectAdapter: new GenericNodeProjectAdapter(),
      commandRunner: new TimedOutSuccessRunner(),
    });
    const view = await orchestrator.start({
      runId: "run-timeout-zero", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run.status).toBe("blocked");
    expect(view.evidence.some((item) => item.kind === "command" && item.status === "valid")).toBe(false);
    expect(view.evidence.some((item) => item.kind === "verification_failure")).toBe(true);
    expect(view.operations.find((operation) => operation.kind === "verify:check")).toMatchObject({
      status: "failed",
      result: { exitCode: 0, timedOut: true },
    });
    orchestrator.close();
  }, 30_000);

  it("repairs a real verification failure in the same Run and commits the repaired candidate", async () => {
    const fixture = repairableRepository();
    const provider = new RepairingAuthor();
    const orchestrator = createOrchestrator(fixture, provider);
    const view = await orchestrator.start({
      runId: "run-repair", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run).toMatchObject({ id: "run-repair", status: "ready" });
    expect(provider.calls).toBe(2);
    expect(view.operations.filter((operation) => operation.kind === "repair")).toHaveLength(1);
    expect(view.operations.filter((operation) => operation.kind === "checkpoint-commit")).toHaveLength(2);
    expect(view.operations.filter((operation) => operation.kind === "verify:check")).toHaveLength(2);
    expect(provider.requests[1]?.prompt).toContain("Deterministic proof-gap evidence:");
    expect(provider.requests[1]?.prompt).toContain("expected fixed, received broken");
    expect(Number(git(view.worktreePath, ["rev-list", "--count", "HEAD"]))).toBe(3);
    expect(view.evidence.filter((item) => item.kind === "verification_failure")).toHaveLength(1);
    expect(view.evidence.filter((item) => item.status === "valid").map((item) => item.kind).sort()).toEqual([
      "candidate_commit", "command",
    ]);
    orchestrator.close();
  }, 60_000);

  it("atomically replaces stale commit-bound Evidence when a repaired candidate is installed", async () => {
    const fixture = repairableRepository();
    const provider = new RepairingAuthor();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    let candidateReceipts = 0;
    const first = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      faults: {
        afterCandidateEvidenceInstalled: () => {
          candidateReceipts += 1;
          if (candidateReceipts === 2) throw new Error("simulated crash after repaired candidate receipt");
        },
      },
    });
    await expect(first.start({
      runId: "run-candidate-atomic", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("repaired candidate receipt");
    const crashed = first.status("run-candidate-atomic");
    const head = git(crashed.worktreePath, ["rev-parse", "HEAD"]);
    const validCommitEvidence = crashed.evidence.filter((item) =>
      item.status === "valid" && item.kind !== "exploration"
    );
    expect(validCommitEvidence.map((item) => item.kind)).toEqual(["candidate_commit"]);
    expect(validCommitEvidence.every((item) => item.commitSha === head)).toBe(true);
    expect(crashed.evidence.filter((item) => item.kind === "candidate_commit" && item.status === "invalid")).toHaveLength(1);
    expect(crashed.evidence.filter((item) => item.kind === "verification_failure" && item.status === "invalid")).toHaveLength(1);
    first.close();

    const resumed = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
    });
    const view = await resumed.resume("run-candidate-atomic");
    expect(view.run.status).toBe("ready");
    expect(view.evidence.filter((item) => item.status === "valid").map((item) => item.kind).sort()).toEqual([
      "candidate_commit", "command",
    ]);
    resumed.close();
  }, 90_000);

  it("resumes after a recorded verification failure without creating a new Run", async () => {
    const fixture = repairableRepository();
    const provider = new RepairingAuthor();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    const first = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      outputSchemaPath: fixture.schemaPath,
      faults: { afterVerificationFailure: () => { throw new Error("simulated restart after failed verification"); } },
    });
    await expect(first.start({
      runId: "run-repair-resume", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("simulated restart");
    expect(first.status("run-repair-resume").run.status).toBe("open");
    first.close();

    const resumed = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      outputSchemaPath: fixture.schemaPath,
    });
    const view = await resumed.resume("run-repair-resume");
    expect(view.run).toMatchObject({ id: "run-repair-resume", status: "ready" });
    expect(resumed.listRuns()).toHaveLength(1);
    expect(provider.calls).toBe(2);
    resumed.close();
  }, 60_000);

  it("re-enters the same unfinished Repair operation after a clean-tree restart", async () => {
    const fixture = repairableRepository();
    const provider = new RepairingAuthor();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    let interrupted = false;
    const first = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      faults: {
        afterWriterOperationCreated: (role) => {
          if (role === "repair" && !interrupted) {
            interrupted = true;
            throw new Error("simulated restart after Repair operation creation");
          }
        },
      },
    });
    await expect(first.start({
      runId: "run-repair-running", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("Repair operation creation");
    expect(first.status("run-repair-running").operations.at(-1)).toMatchObject({
      id: "run-repair-running:repair:1", kind: "repair", status: "running",
    });
    first.close();

    const resumed = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
    });
    const view = await resumed.resume("run-repair-running");
    expect(view.run.status).toBe("ready");
    expect(view.operations.filter((operation) => operation.kind === "repair")).toHaveLength(1);
    expect(view.operations.some((operation) => operation.id.endsWith("repair:2"))).toBe(false);
    expect(provider.calls).toBe(2);
    resumed.close();
  }, 90_000);

  it("blocks a repeated failure signature after the one bounded Repair", async () => {
    const fixture = repairableRepository();
    const provider = new RepairingAuthor(false);
    const orchestrator = createOrchestrator(fixture, provider);
    const view = await orchestrator.start({
      runId: "run-repeat", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("repeated failure signature");
    expect(view.operations.filter((operation) => operation.kind === "repair")).toHaveLength(1);
    expect(view.operations.filter((operation) => operation.kind === "verify:check")).toHaveLength(2);
    orchestrator.close();
  }, 60_000);

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
    expect(view.evidence).toHaveLength(0);
    expect(orchestrator.store.listHumanInbox("run-unknown-risk")).toHaveLength(1);
    orchestrator.close();
  }, 20_000);

  it("enforces the Project Adapter risk floor over a low Task YAML declaration", async () => {
    const fixture = targetRepository();
    writeFileSync(
      fixture.taskPath,
      readFileSync(fixture.taskPath, "utf8").replace("risk: low", "scope:\n  - src/security/\nrisk: low"),
    );
    git(fixture.root, ["add", "task.yaml"]);
    git(fixture.root, ["commit", "-m", "test: add sensitive scope"]);
    const orchestrator = createOrchestrator(fixture, new FakeAuthor());
    const view = await orchestrator.start({
      runId: "run-risk-floor", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });

    expect(view.run.binding).toMatchObject({ risk: "high", executionTemplate: "reviewed" });
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.checkpointRef).toBe("independent-review");
    orchestrator.close();
  }, 30_000);

  it("recomputes a monotonic risk floor from actual changed files", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new SensitivePathAuthor());
    const view = await orchestrator.start({
      runId: "run-risk-changed-files", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });

    expect(view.run.binding).toMatchObject({ risk: "high", executionTemplate: "reviewed" });
    expect(view.run.status).toBe("blocked");
    expect(view.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "run.risk-escalated",
        data: expect.objectContaining({ from: "low", to: "high" }),
      }),
    ]));
    orchestrator.close();
  }, 30_000);

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
    expect(view.evidence.filter((item) => item.status === "valid").map((item) => item.kind).sort()).toEqual([
      "candidate_commit", "command", "exploration",
    ]);
    const exploration = view.evidence.find((item) => item.kind === "exploration");
    expect(exploration?.dependencies).toMatchObject({
      commitSha: view.run.binding?.baselineCommit,
      taskSpecHash: view.run.binding?.taskSpecHash,
      acceptanceHash: view.run.binding?.acceptanceHash,
      policyVersion: view.run.binding?.policyVersion,
      stepId: "exploration",
    });
    orchestrator.close();
  }, 20_000);

  it("recovers Explorer Evidence after a crash without invoking Explorer twice", async () => {
    const fixture = targetRepository(false, "normal");
    const provider = new FakeAuthor();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    const first = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      faults: { afterExplorerOperationCompleted: () => { throw new Error("simulated Explorer receipt crash"); } },
    });
    await expect(first.start({
      runId: "run-explorer-receipt", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("Explorer receipt crash");
    expect(first.status("run-explorer-receipt").operations[0]).toMatchObject({
      kind: "explorer", status: "succeeded",
    });
    expect(first.status("run-explorer-receipt").evidence).toHaveLength(0);
    first.close();

    const resumed = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
    });
    const view = await resumed.resume("run-explorer-receipt");
    expect(view.run.status).toBe("ready");
    expect(provider.requests.filter((request) => request.workspaceAccess === "read-only")).toHaveLength(1);
    expect(view.evidence.filter((item) => item.status === "valid").map((item) => item.kind).sort()).toEqual([
      "candidate_commit", "command", "exploration",
    ]);
    resumed.close();
  }, 60_000);

  it("rejects an attempted Explorer write at the Harness boundary", async () => {
    const fixture = targetRepository(false, "normal");
    const orchestrator = createOrchestrator(fixture, new WritingExplorer());

    const view = await orchestrator.start({
      runId: "run-explorer-write", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("read-only workspace boundary");
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

  it("rejects a Provider commit followed by reset even when the final diff looks valid", async () => {
    const fixture = targetRepository();
    const orchestrator = createOrchestrator(fixture, new CommitResetAuthor());
    const view = await orchestrator.start({
      runId: "run-provider-reset", taskPath: fixture.taskPath, targetRepository: fixture.root,
    });
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("Git refs or reflogs");
    expect(view.operations.map((operation) => operation.kind)).toEqual(["author"]);
    expect(view.evidence).toHaveLength(0);
    orchestrator.close();
  }, 30_000);

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

  it("refuses to bless an external same-parent commit during checkpoint recovery", async () => {
    const fixture = targetRepository();
    const provider = new FakeAuthor();
    const orchestrator = createOrchestrator(fixture, provider, new GenericNodeProjectAdapter(), {
      afterHarnessCommit: () => { throw new Error("simulated checkpoint crash"); },
    });
    await expect(orchestrator.start({
      runId: "run-commit-replaced", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("checkpoint crash");
    const crashed = orchestrator.status("run-commit-replaced");
    const baseCommit = crashed.run.binding?.baselineCommit;
    expect(baseCommit).toBeTruthy();
    git(crashed.worktreePath, ["reset", "--hard", baseCommit!]);
    writeFileSync(join(crashed.worktreePath, "changed.txt"), "external replacement\n");
    git(crashed.worktreePath, ["add", "changed.txt"]);
    git(crashed.worktreePath, ["commit", "-m", "external replacement"]);

    const blocked = await orchestrator.resume("run-commit-replaced");
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.blocked?.reason).toContain("ambiguous");
    expect(blocked.operations.find((operation) => operation.kind === "checkpoint-commit")).toMatchObject({
      status: "failed",
    });
    expect(blocked.evidence).toHaveLength(0);
    orchestrator.close();
  }, 30_000);

  it("never recovers a failed Provider completion as a successful Writer", async () => {
    const fixture = targetRepository();
    const provider = new FailedResultAuthor();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-home-"));
    temporaryDirectories.push(loopHome);
    const first = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
      faults: { afterProviderCompletion: () => { throw new Error("simulated crash after failed Provider result"); } },
    });
    await expect(first.start({
      runId: "run-failed-receipt", taskPath: fixture.taskPath, targetRepository: fixture.root,
    })).rejects.toThrow("failed Provider result");
    expect(first.status("run-failed-receipt").operations[0]).toMatchObject({ status: "running" });
    first.close();

    const resumed = new Orchestrator({
      loopHome,
      provider,
      projectAdapter: new GenericNodeProjectAdapter(),
    });
    const view = await resumed.resume("run-failed-receipt");
    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("unsuccessfully");
    expect(view.operations[0]).toMatchObject({ kind: "author", status: "failed" });
    expect(view.operations.some((operation) => operation.kind === "checkpoint-commit")).toBe(false);
    expect(view.evidence).toHaveLength(0);
    expect(provider.calls).toBe(1);
    resumed.close();
  }, 30_000);

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
  }, 60_000);

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
      policyVersion: "generic-node/v2",
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
      minimumRisk: (input) => base.minimumRisk(input),
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
  }, 90_000);
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
    expect(result.stdout).toContain("--provider-profile");
  });
});
