import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceDependencies,
  evidenceDependencyHash,
  operationInputHash,
} from "../src/bindings.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createProviderProfile } from "../src/profiles.js";
import { GenericNodeProjectAdapter } from "../src/project.js";
import type {
  ProviderAdapter,
  ProviderFailureClass,
  ProviderRunRequest,
  ProviderRunResult,
} from "../src/provider.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(risk: "normal" | "high" = "high"): { root: string; taskPath: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-reviewed-target-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "reviewed@example.invalid"]);
  git(root, ["config", "user.name", "Reviewed Test"]);
  writeFileSync(
    join(root, "check.mjs"),
    "import { existsSync, readFileSync } from 'node:fs'; if (!existsSync('changed.txt')) process.exit(4); console.log(readFileSync('changed.txt', 'utf8').trim());\n",
  );
  const taskPath = join(root, "task.yaml");
  writeFileSync(taskPath, [
    "id: REVIEWED-1",
    "goal: Add a reviewed change",
    "acceptance:",
    "  - changed.txt exists and contains the reviewed result",
    `risk: ${risk}`,
    "verification:",
    "  - id: check",
    "    argv: [node, check.mjs]",
    "",
  ].join("\n"));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { root, taskPath };
}

function result(
  request: ProviderRunRequest,
  provider: string,
  finalOutput: unknown,
  failureClass: ProviderFailureClass | null = null,
): ProviderRunResult {
  const ok = failureClass === null;
  return {
    invocationId: request.invocationId,
    ok,
    cancelled: false,
    identity: { provider, model: "fixture", executable: "in-process", version: "1" },
    threadId: ok ? `${provider}-thread` : null,
    events: [],
    finalOutput: ok ? finalOutput : null,
    stderr: ok ? "" : `${failureClass} failure`,
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 1,
    usage: null,
    failureClass,
    eventsPath: join(request.artifactDirectory, "events.jsonl"),
    finalOutputPath: join(request.artifactDirectory, "final.json"),
    stderrPath: join(request.artifactDirectory, "stderr.log"),
  };
}

class RepairingAuthor implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "enforced" } as const;
  readonly requests: ProviderRunRequest[] = [];

  async probe() {
    return { available: true, identity: this.identity(), error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.requests.push(request);
    mkdirSync(request.artifactDirectory, { recursive: true });
    const repairing = request.prompt.includes("Role: bounded Repair attempt");
    writeFileSync(join(request.cwd, "changed.txt"), repairing ? "fixed\n" : "broken\n");
    return result(request, "observed-author", {
      summary: repairing ? "Repaired the reviewed finding" : "Added the initial change",
      changedFiles: ["changed.txt"],
    });
  }

  async cancel() { return false; }

  private identity() {
    return { provider: "observed-author", model: "fixture", executable: "in-process", version: "1" };
  }
}

class QuotaAuthor implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "enforced" } as const;
  readonly requests: ProviderRunRequest[] = [];

  async probe() {
    return { available: true, identity: { provider: "quota-author", model: null, executable: "fixture", version: "1" }, error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.requests.push(request);
    return result(request, "quota-author", null, "quota");
  }

  async cancel() { return false; }
}

class FallbackAuthor implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "enforced" } as const;
  readonly requests: ProviderRunRequest[] = [];

  async probe() {
    return { available: true, identity: { provider: "fallback-author", model: null, executable: "fixture", version: "1" }, error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.requests.push(request);
    if (request.workspaceAccess === "read-only") {
      return result(request, "fallback-author", {
        relevantFiles: [{ path: "check.mjs", symbols: [] }],
        likelyAffectedTests: ["check.mjs"],
        evidence: [{ path: "check.mjs", observation: "Verification expects changed.txt" }],
        importantUnknowns: [],
      });
    }
    writeFileSync(join(request.cwd, "changed.txt"), "fallback author\n");
    return result(request, "fallback-author", {
      summary: "Completed the change after primary Author quota exhaustion",
      changedFiles: ["changed.txt"],
    });
  }

  async cancel() { return false; }
}

type ReviewOutcome = "clean" | "blocking" | "unsupported" | "quota";

class Reviewer implements ProviderAdapter {
  readonly workspaceIsolation;
  readonly requests: ProviderRunRequest[] = [];

  constructor(
    private readonly providerName: string,
    private readonly outcomes: ReviewOutcome[],
    readOnly: "enforced" | "unverified" = "enforced",
  ) {
    this.workspaceIsolation = { readOnly, workspaceWrite: "unverified" as const };
  }

  async probe() {
    return { available: true, identity: this.identity(), error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.requests.push(request);
    const outcome = this.outcomes.shift() ?? "clean";
    if (outcome === "quota") return result(request, this.providerName, null, "quota");
    return result(request, this.providerName, {
      findings: outcome === "blocking" || outcome === "unsupported" ? [{
        id: "F-1",
        category: "acceptance",
        severity: "high",
        claim: "changed.txt still contains the unreviewed value",
        location: "changed.txt:1",
        verificationRequest: outcome === "blocking" ? {
          verificationStepId: "check",
          proposedArgv: [process.execPath, "check.mjs"],
          expectedExitCode: 0,
          stdoutIncludes: "broken",
        } : null,
        evidenceIds: [],
        confidence: 1,
        proposedVerification: "read changed.txt after Repair",
        status: "proposed",
      }] : [],
    });
  }

  async cancel() { return false; }

  private identity() {
    return { provider: this.providerName, model: "fixture", executable: "in-process", version: "1" };
  }
}

class ControlStateTamperingReviewer implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "enforced", workspaceWrite: "unverified" } as const;
  readonly requests: ProviderRunRequest[] = [];

  constructor(private readonly targetWorktree: string) {}

  async probe() {
    return { available: true, identity: this.identity(), error: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.requests.push(request);
    const original = git(this.targetWorktree, ["rev-parse", "HEAD"]);
    git(this.targetWorktree, ["commit", "--allow-empty", "-m", "reviewer boundary violation"]);
    git(this.targetWorktree, ["reset", "--hard", original]);
    return result(request, "tampering-reviewer", { findings: [] });
  }

  async cancel() { return false; }

  private identity() {
    return { provider: "tampering-reviewer", model: "fixture", executable: "in-process", version: "1" };
  }
}

function orchestrator(
  author: ProviderAdapter,
  primary: ProviderAdapter,
  fallback: ProviderAdapter,
  loopHome = mkdtempSync(join(tmpdir(), "agent-loop-reviewed-home-")),
  faults?: { afterReviewProviderCompletion?: () => void },
): Orchestrator {
  if (!temporaryDirectories.includes(loopHome)) temporaryDirectories.push(loopHome);
  return new Orchestrator({
    loopHome,
    providerProfile: createProviderProfile("CODEX_PRIMARY", {
      codex: { adapter: author, family: "codex", name: "Configured Codex Author" },
      claude: { adapter: primary, family: "claude", name: "Configured Claude Reviewer" },
      deepseek: { adapter: fallback, family: "deepseek", name: "Configured DeepSeek Reviewer" },
    }),
    projectAdapter: new GenericNodeProjectAdapter(),
    faults,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("reviewed Orchestrator profile", () => {
  it("falls back the read-only Explorer without widening its workspace boundary", async () => {
    const target = fixture("normal");
    const primary = new QuotaAuthor();
    const fallback = new FallbackAuthor();
    const loop = orchestrator(primary, fallback, new Reviewer("unused-reviewer", ["clean"]));
    const view = await loop.start({
      runId: "assisted-explorer-fallback", taskPath: target.taskPath, targetRepository: target.root,
    });

    expect(view.run).toMatchObject({ status: "ready", binding: { executionTemplate: "assisted" } });
    expect(primary.requests.map((request) => request.workspaceAccess)).toEqual(["read-only", "workspace-write"]);
    expect(fallback.requests.map((request) => request.workspaceAccess)).toEqual(["read-only", "workspace-write"]);
    expect(view.operations.find((item) => item.kind === "explorer")?.result).toMatchObject({
      selectedExplorer: { family: "claude" },
    });
    expect(view.operations.find((item) => item.kind === "author")?.result).toMatchObject({
      selectedAuthor: { family: "claude" },
    });
    loop.close();
  }, 120_000);

  it("falls back the Author and filters review against the actual successful family", async () => {
    const target = fixture();
    const primaryAuthor = new QuotaAuthor();
    const fallbackAuthor = new FallbackAuthor();
    const independentReviewer = new Reviewer("deepseek-after-claude-author", ["clean"]);
    const loop = orchestrator(primaryAuthor, fallbackAuthor, independentReviewer);
    const view = await loop.start({
      runId: "reviewed-author-fallback", taskPath: target.taskPath, targetRepository: target.root,
    });

    expect(view.run.status).toBe("ready");
    expect(primaryAuthor.requests).toHaveLength(1);
    expect(fallbackAuthor.requests.filter((request) => request.workspaceAccess === "workspace-write")).toHaveLength(1);
    expect(fallbackAuthor.requests.filter((request) => request.workspaceAccess === "read-only")).toHaveLength(0);
    expect(independentReviewer.requests).toHaveLength(1);
    expect(view.operations.find((item) => item.kind === "author")?.result).toMatchObject({
      selectedAuthor: { family: "claude", name: "Configured Claude Reviewer" },
    });
    expect(view.evidence.find((item) => item.kind === "independent_review")?.data).toMatchObject({
      selectedReviewer: {
        configuredFamily: "deepseek",
        observedIdentity: { provider: "deepseek-after-claude-author" },
      },
    });
    expect(view.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.fallback", data: expect.objectContaining({ role: "author", reason: "quota" }) }),
    ]));
    loop.close();
  }, 120_000);

  it("keeps an unavailable Author operation recoverable", async () => {
    const target = fixture();
    const primaryAuthor = new QuotaAuthor();
    const fallbackAuthor = new QuotaAuthor();
    const loop = orchestrator(primaryAuthor, fallbackAuthor, new Reviewer("unused-reviewer", ["clean"]));
    const view = await loop.start({
      runId: "reviewed-author-recovery", taskPath: target.taskPath, targetRepository: target.root,
    });

    expect(view.run).toMatchObject({ status: "blocked", blocked: { checkpointRef: "provider-recovery" } });
    expect(view.operations.find((item) => item.kind === "author")?.status).toBe("running");
    expect(view.events.some((item) => item.type === "writer.provider-blocked")).toBe(true);
    loop.close();
  }, 60_000);

  it("repairs one blocking independent finding, then re-verifies and re-reviews the same Run", async () => {
    const target = fixture();
    const author = new RepairingAuthor();
    const reviewer = new Reviewer("observed-provider-claiming-any-family", ["blocking", "clean"]);
    const loop = orchestrator(author, reviewer, new Reviewer("unused-fallback", ["clean"]));
    const view = await loop.start({ runId: "reviewed-repair", taskPath: target.taskPath, targetRepository: target.root });

    expect(view.run).toMatchObject({ status: "ready", binding: { providerProfile: "CODEX_PRIMARY" } });
    expect(author.requests).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(2);
    expect(author.requests[1]?.prompt).toContain("changed.txt still contains the unreviewed value");
    expect(reviewer.requests[0]?.cwd).toBe(view.worktreePath);
    expect(view.operations.filter((item) => item.kind === "repair")).toHaveLength(1);
    expect(view.operations.filter((item) => item.kind === "finding-validation")).toHaveLength(1);
    expect(view.operations.filter((item) => item.kind === "verify:check")).toHaveLength(2);
    expect(view.operations.filter((item) => item.kind === "independent-review")).toHaveLength(2);
    expect(Number(git(view.worktreePath, ["rev-list", "--count", "HEAD"]))).toBe(3);

    const valid = view.evidence.filter((item) => item.status === "valid");
    const review = valid.find((item) => item.kind === "independent_review");
    const acceptance = valid.find((item) => item.kind === "acceptance_binding");
    expect(review?.data).toMatchObject({
      blocking: false,
      selectedReviewer: {
        configuredFamily: "claude",
        configuredName: "Configured Claude Reviewer",
        observedIdentity: { provider: "observed-provider-claiming-any-family" },
      },
    });
    expect(review?.dependencies).toMatchObject({
      commitSha: git(view.worktreePath, ["rev-parse", "HEAD"]),
      taskSpecHash: view.run.binding?.taskSpecHash,
      acceptanceHash: view.run.binding?.acceptanceHash,
      policyVersion: view.run.binding?.policyVersion,
    });
    expect(acceptance?.dependencies).toMatchObject({
      commitSha: git(view.worktreePath, ["rev-parse", "HEAD"]),
      taskSpecHash: view.run.binding?.taskSpecHash,
      acceptanceHash: view.run.binding?.acceptanceHash,
      policyVersion: view.run.binding?.policyVersion,
      stepId: "acceptance-binding",
    });
    expect(view.evidence.filter((item) => item.kind === "independent_review" && item.status === "invalid")).toHaveLength(1);
    loop.close();
  }, 180_000);

  it("keeps an unsupported model-only Finding proposed and routes it to Human Inbox", async () => {
    const target = fixture();
    const author = new RepairingAuthor();
    const reviewer = new Reviewer("unsupported-claim-reviewer", ["unsupported"]);
    const loop = orchestrator(author, reviewer, new Reviewer("unused-fallback", ["clean"]));
    const view = await loop.start({
      runId: "reviewed-unconfirmed-claim", taskPath: target.taskPath, targetRepository: target.root,
    });

    expect(view.run.status).toBe("blocked");
    expect(author.requests).toHaveLength(1);
    expect(view.operations.filter((item) => item.kind === "repair")).toHaveLength(0);
    expect(view.operations.find((item) => item.kind === "finding-validation")?.result).toMatchObject({
      status: "inconclusive",
    });
    expect(view.evidence.find((item) => item.kind === "independent_review")?.data).toMatchObject({
      blocking: false,
      report: { findings: [expect.objectContaining({ status: "proposed" })] },
    });
    expect(loop.store.listHumanInbox(view.run.id)).toEqual([
      expect.objectContaining({
        recommendation: "add-project-verification-step",
        options: expect.arrayContaining(["inspect-finding-evidence", "add-project-verification-step"]),
      }),
    ]);
    loop.close();
  }, 120_000);

  it("persists quota fallback facts and binds the receipt to the selected configured family", async () => {
    const target = fixture();
    const primary = new Reviewer("primary-observed", ["quota"]);
    const fallback = new Reviewer("fallback-observed", ["clean"]);
    const loop = orchestrator(new RepairingAuthor(), primary, fallback);
    const view = await loop.start({ runId: "reviewed-fallback", taskPath: target.taskPath, targetRepository: target.root });

    expect(view.run.status).toBe("ready");
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(view.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.failure", data: expect.objectContaining({ failureClass: "quota" }) }),
      expect.objectContaining({ type: "provider.fallback", data: expect.objectContaining({ reason: "quota" }) }),
      expect.objectContaining({ type: "provider.checkpoint", data: expect.objectContaining({ provider: "fallback-observed" }) }),
    ]));
    expect(loop.store.listPendingOutbox()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider-fallback", payload: expect.objectContaining({ reason: "quota" }) }),
    ]));
    expect(view.evidence.find((item) => item.kind === "independent_review")?.data).toMatchObject({
      selectedReviewer: { configuredFamily: "deepseek", observedIdentity: { provider: "fallback-observed" } },
    });
    loop.close();
  }, 60_000);

  it("fails high-risk work closed when no independent Reviewer proves read-only isolation", async () => {
    const target = fixture();
    const primary = new Reviewer("unsafe-primary", ["clean"], "unverified");
    const fallback = new Reviewer("unsafe-fallback", ["clean"], "unverified");
    const loop = orchestrator(new RepairingAuthor(), primary, fallback);
    const view = await loop.start({ runId: "reviewed-no-safe-reviewer", taskPath: target.taskPath, targetRepository: target.root });

    expect(view.run).toMatchObject({ status: "blocked", blocked: { checkpointRef: "independent-review" } });
    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(0);
    expect(view.evidence.some((item) => item.kind === "independent_review" && item.status === "valid")).toBe(false);
    expect(loop.store.listHumanInbox("reviewed-no-safe-reviewer")).toHaveLength(1);
    expect(loop.store.listPendingOutbox().some((item) => item.type === "needs-human")).toBe(true);
    loop.close();
  }, 60_000);

  it("recovers a durable fallback Reviewer completion without invoking either Provider again", async () => {
    const target = fixture();
    const author = new RepairingAuthor();
    const primary = new Reviewer("primary-once", ["quota"]);
    const fallback = new Reviewer("fallback-once", ["clean"]);
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-reviewed-home-"));
    temporaryDirectories.push(loopHome);
    const first = orchestrator(author, primary, fallback, loopHome, {
      afterReviewProviderCompletion: () => { throw new Error("simulated restart after durable Reviewer receipt"); },
    });
    await expect(first.start({
      runId: "reviewed-receipt-recovery", taskPath: target.taskPath, targetRepository: target.root,
    })).rejects.toThrow("durable Reviewer receipt");
    expect(first.status("reviewed-receipt-recovery").operations.at(-1)).toMatchObject({
      kind: "independent-review", status: "running",
    });
    expect(first.status("reviewed-receipt-recovery").events.some((item) =>
      item.type === "review.provider-completed"
    )).toBe(true);
    first.close();

    const resumed = orchestrator(author, primary, fallback, loopHome);
    const view = await resumed.resume("reviewed-receipt-recovery");
    expect(view.run.status).toBe("ready");
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(view.operations.filter((item) => item.kind === "independent-review")).toHaveLength(1);
    expect(view.operations.find((item) => item.kind === "independent-review")?.result).toMatchObject({
      recoveredAfterProviderCompletion: true,
    });
    expect(resumed.store.listPendingOutbox().filter((item) => item.type === "provider-fallback")).toHaveLength(1);
    resumed.close();
  }, 120_000);

  it("resumes the same Review operation after all Reviewers were temporarily unavailable", async () => {
    const target = fixture();
    const author = new RepairingAuthor();
    const primary = new Reviewer("recovering-primary", ["quota", "clean"]);
    const fallback = new Reviewer("temporarily-unavailable-fallback", ["quota"]);
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-reviewed-home-"));
    temporaryDirectories.push(loopHome);
    const first = orchestrator(author, primary, fallback, loopHome);
    const blocked = await first.start({
      runId: "reviewed-provider-recovery", taskPath: target.taskPath, targetRepository: target.root,
    });
    expect(blocked.run).toMatchObject({ status: "blocked", blocked: { checkpointRef: "provider-recovery" } });
    expect(blocked.operations.filter((item) => item.kind === "independent-review")).toHaveLength(1);
    expect(blocked.operations.find((item) => item.kind === "independent-review")?.status).toBe("running");
    first.close();

    const resumed = orchestrator(author, primary, fallback, loopHome);
    const ready = await resumed.resume("reviewed-provider-recovery");
    expect(ready.run.status).toBe("ready");
    expect(author.requests).toHaveLength(1);
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(1);
    expect(ready.operations.filter((item) => item.kind === "independent-review")).toHaveLength(1);
    expect(ready.operations.find((item) => item.kind === "independent-review")?.status).toBe("succeeded");
    resumed.close();
  }, 120_000);

  it("re-reviews when the verification proof set changes on the same commit", async () => {
    const target = fixture();
    const reviewer = new Reviewer("proof-set-reviewer", ["clean", "clean"]);
    const loop = orchestrator(new RepairingAuthor(), reviewer, new Reviewer("unused-fallback", ["clean"]));
    const first = await loop.start({
      runId: "reviewed-proof-set", taskPath: target.taskPath, targetRepository: target.root,
    });
    const binding = first.run.binding;
    const currentCommand = first.evidence.find((item) => item.kind === "command" && item.status === "valid");
    const firstReview = first.evidence.find((item) => item.kind === "independent_review" && item.status === "valid");
    expect(binding).not.toBeNull();
    expect(currentCommand).toBeDefined();
    expect(firstReview).toBeDefined();

    const stepId = "verify:augmented-proof";
    const input = {
      kind: "command",
      phase: "verify",
      commandId: "augmented-proof",
      argv: [process.execPath, "--version"],
      cwd: first.worktreePath,
    };
    const dependencies = evidenceDependencies({
      commitSha: git(first.worktreePath, ["rev-parse", "HEAD"]),
      taskSpecHash: binding!.taskSpecHash,
      acceptanceHash: binding!.acceptanceHash,
      policyVersion: binding!.policyVersion,
      stepId,
      operationInputHash: operationInputHash(input),
    });
    const dependencyHash = evidenceDependencyHash(dependencies);
    loop.store.installEvidence({
      id: `reviewed-proof-set:evidence:command:${dependencyHash.slice(0, 12)}`,
      runId: "reviewed-proof-set",
      operationId: currentCommand!.operationId,
      kind: "command",
      commitSha: dependencies.commitSha,
      policyVersion: binding!.policyVersion,
      stepId,
      dependencyHash,
      dependencies,
      data: { argv: input.argv, exitCode: 0 },
    });

    const second = await loop.resume("reviewed-proof-set");
    expect(second.run.status).toBe("ready");
    expect(reviewer.requests).toHaveLength(2);
    expect(second.operations.filter((item) => item.kind === "independent-review")).toHaveLength(2);
    expect(second.evidence.find((item) => item.id === firstReview!.id)?.status).toBe("invalid");
    expect(second.evidence.filter((item) => item.kind === "independent_review" && item.status === "valid")).toHaveLength(1);
    loop.close();
  }, 120_000);

  it("blocks a Reviewer that commits and resets the candidate behind the read-only boundary", async () => {
    const target = fixture();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-reviewed-home-"));
    temporaryDirectories.push(loopHome);
    const runId = "reviewed-control-state";
    const targetWorktree = join(loopHome, "worktrees", runId);
    const reviewer = new ControlStateTamperingReviewer(targetWorktree);
    const loop = orchestrator(
      new RepairingAuthor(), reviewer, new Reviewer("unused-fallback", ["clean"]), loopHome,
    );
    const view = await loop.start({ runId, taskPath: target.taskPath, targetRepository: target.root });

    expect(view.run.status).toBe("blocked");
    expect(view.run.blocked?.reason).toContain("evidence check failed");
    expect(reviewer.requests).toHaveLength(1);
    expect(view.operations.find((item) => item.kind === "independent-review")?.status).toBe("failed");
    expect(view.evidence.some((item) => item.kind === "independent_review" && item.status === "valid")).toBe(false);
    expect(git(targetWorktree, ["status", "--short"])).toBe("");
    loop.close();
  }, 120_000);
});
