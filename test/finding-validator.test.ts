import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence } from "../src/domain.js";
import type { CommandRequest, CommandResult } from "../src/execution.js";
import {
  FindingValidator,
  findingClaimHash,
  isBoundFindingValidationDecision,
} from "../src/finding-validator.js";
import type { ProjectAdapter, VerificationCommand } from "../src/ports.js";
import type { Finding } from "../src/reviewer.js";
import type { TaskSpec } from "../src/task-spec.js";

const commit = "abc123";
const temporaryDirectories: string[] = [];

const task: TaskSpec = {
  id: "SEC-1",
  goal: "verify a security fix",
  acceptance: ["the security condition is absent"],
  risk: "high",
  verification: [{ id: "security-check", argv: ["verify", "--check"] }],
};

const stableGit = {
  head: () => commit,
  isDirty: () => false,
  diffHash: () => "diff-hash",
  controlStateHash: () => "control-hash",
};

class Adapter implements ProjectAdapter {
  readonly name = "test";
  readonly policyVersion = "test/v1";

  constructor(private readonly commands: readonly VerificationCommand[]) {}

  minimumRisk() { return "high" as const; }
  verificationCommands() { return this.commands; }
  postMergeCommands() { return this.commands; }
}

class RecordingRunner {
  calls: CommandRequest[] = [];

  constructor(private readonly result?: (request: CommandRequest) => CommandResult) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (!this.result) throw new Error("unexpected execution");
    return this.result(request);
  }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-SEC",
    category: "security",
    severity: "high",
    claim: "authorization can be bypassed",
    location: "src/auth.ts:10",
    verificationRequest: null,
    evidenceIds: [],
    confidence: 0.9,
    proposedVerification: "run the declared security check",
    status: "proposed",
    reviewerIdentity: { provider: "reviewer", model: null, executable: "fixture", version: "1" },
    reviewedCommit: commit,
    ...overrides,
  };
}

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    id: "E-1",
    runId: "run-1",
    operationId: "operation-1",
    kind: "command",
    status: "valid",
    commitSha: commit,
    policyVersion: "test/v1",
    stepId: "verify:typecheck",
    dependencyHash: "dependency",
    dependencyVersion: null,
    dependencies: null,
    data: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    invalidatedAt: null,
    ...overrides,
  };
}

function input(currentFinding: Finding, currentEvidence: readonly Evidence[] = []) {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "finding-validator-"));
  temporaryDirectories.push(artifactDirectory);
  return {
    finding: currentFinding,
    reviewedCommit: commit,
    task,
    worktreePath: artifactDirectory,
    artifactDirectory,
    evidence: currentEvidence,
    git: stableGit,
  };
}

function resultWithOutput(request: CommandRequest, stdout: string, stderr: string, exitCode: number): CommandResult {
  const stdoutPath = join(request.artifactDirectory, "stdout.log");
  const stderrPath = join(request.artifactDirectory, "stderr.log");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  return {
    argv: request.argv,
    cwd: request.cwd,
    exitCode,
    signal: null,
    durationMs: 1,
    timedOut: false,
    stdoutPath,
    stderrPath,
    stdoutTruncated: false,
    stderrTruncated: false,
    commitBefore: commit,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FindingValidator evidence and execution boundaries", () => {
  it("rechecks Finding identity, claim hash, and commit when loading a persisted decision", () => {
    const expected = { findingId: "F-SEC", claimHash: "claim-hash", reviewedCommit: commit };
    const decision = {
      ...expected,
      status: "confirmed",
      reason: "matched",
      verificationRequest: null,
      machineEvidenceIds: ["E-1"],
      commandResult: null,
      commandError: null,
      predicateEvaluation: null,
    };

    expect(isBoundFindingValidationDecision(decision, expected)).toBe(true);
    expect(isBoundFindingValidationDecision({ ...decision, claimHash: "different" }, expected)).toBe(false);
    expect(isBoundFindingValidationDecision({ ...decision, reviewedCommit: "different" }, expected)).toBe(false);
  });

  it("does not let passing typecheck Evidence confirm an unrelated security Finding", async () => {
    const runner = new RecordingRunner();
    const currentFinding = finding({ evidenceIds: ["E-TYPECHECK"] });
    const decision = await new FindingValidator(new Adapter(task.verification), runner).validate(input(
      currentFinding,
      [evidence({ id: "E-TYPECHECK", kind: "command", data: { exitCode: 0 } })],
    ));

    expect(decision.status).toBe("inconclusive");
    expect(decision.machineEvidenceIds).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("rejects finding_validation Evidence with a different claim hash at the same commit", async () => {
    const runner = new RecordingRunner();
    const currentFinding = finding({ evidenceIds: ["E-VALIDATION"] });
    const decision = await new FindingValidator(new Adapter(task.verification), runner).validate(input(
      currentFinding,
      [evidence({
        id: "E-VALIDATION",
        kind: "finding_validation",
        stepId: "finding-validation:F-SEC",
        data: {
          findingId: currentFinding.id,
          claimHash: `${findingClaimHash(currentFinding)}-different`,
          reviewedCommit: commit,
          status: "confirmed",
        },
      })],
    ));

    expect(decision.status).toBe("inconclusive");
    expect(decision.machineEvidenceIds).toEqual([]);
  });

  it("accepts failure Evidence only when step, argv, commit, predicate, and observed result all match", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const currentFinding = finding({
      verificationRequest: {
        verificationStepId: command.id,
        proposedArgv: command.argv,
        expectedExitCode: 2,
        stderrIncludes: "bypass reproduced",
      },
      evidenceIds: ["E-FAILURE"],
    });
    const machineResult: CommandResult = {
      argv: command.argv,
      cwd: "/repo",
      exitCode: 2,
      signal: null,
      durationMs: 1,
      timedOut: false,
      stdoutPath: "/artifacts/stdout.log",
      stderrPath: "/artifacts/stderr.log",
      stdoutTruncated: false,
      stderrTruncated: false,
      commitBefore: commit,
    };
    const matchingEvidence = evidence({
      id: "E-FAILURE",
      kind: "verification_failure",
      stepId: "verification-failure:security-check",
      data: {
        commandId: command.id,
        argv: command.argv,
        result: machineResult,
        stdout: "",
        stderr: "authorization bypass reproduced",
      },
    });
    const runner = new RecordingRunner();
    const validator = new FindingValidator(new Adapter([command]), runner);

    expect((await validator.validate(input(currentFinding, [matchingEvidence]))).status).toBe("confirmed");
    expect((await validator.validate(input(currentFinding, [{
      ...matchingEvidence,
      data: { ...matchingEvidence.data as Record<string, unknown>, commandId: "different-step" },
    }]))).status).toBe("inconclusive");
    expect(runner.calls).toHaveLength(1);
  });

  it("does not confirm a declared node command solely because it exits zero", async () => {
    const command: VerificationCommand = { id: "empty-success", argv: ["node", "-e", "process.exit(0)"] };
    const runner = new RecordingRunner();
    const decision = await new FindingValidator(new Adapter([command]), runner).validate(input(finding({
      verificationRequest: {
        verificationStepId: command.id,
        proposedArgv: command.argv,
        expectedExitCode: 0,
      },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("Exit code alone");
    expect(runner.calls).toEqual([]);
  });

  it.each(["curl", "rm", "python"])("never executes an undeclared %s diagnostic", async (executable) => {
    const runner = new RecordingRunner();
    const decision = await new FindingValidator(new Adapter(task.verification), runner).validate(input(finding({
      verificationRequest: { proposedArgv: [executable, "unsafe"], stdoutIncludes: "reproduced" },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("not declared");
    expect(runner.calls).toEqual([]);
  });

  it("confirms a whitelisted command only when every structured predicate matches", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner((request) => resultWithOutput(
      request,
      "",
      "security finding reproduced\n",
      2,
    ));
    const validator = new FindingValidator(new Adapter([command]), runner);
    const request = {
      verificationStepId: command.id,
      proposedArgv: command.argv,
      expectedExitCode: 2,
      stderrIncludes: "security finding reproduced",
    };

    expect((await validator.validate(input(finding({ verificationRequest: request })))).status).toBe("confirmed");
    expect((await validator.validate(input(finding({
      verificationRequest: { ...request, stderrIncludes: "different defect" },
    })))).status).toBe("rejected");
    expect(runner.calls).toHaveLength(2);
  });

  it("leaves Run facts, Git facts, Acceptance, and prior Evidence unchanged after an inconclusive validation", async () => {
    const run = { id: "run-1", status: "open", taskId: task.id } as const;
    const acceptance = [...task.acceptance];
    const priorEvidence = [evidence({ id: "E-PRIOR", kind: "acceptance_binding" })];
    const before = JSON.stringify({ run, acceptance, priorEvidence, git: {
      head: stableGit.head(), dirty: stableGit.isDirty(), diffHash: stableGit.diffHash(), control: stableGit.controlStateHash(),
    } });
    const runner = new RecordingRunner();

    const decision = await new FindingValidator(new Adapter(task.verification), runner).validate(input(finding({
      verificationRequest: { proposedArgv: ["rm", "-rf", "."], stderrIncludes: "removed" },
    }), priorEvidence));

    expect(decision.status).toBe("inconclusive");
    expect(runner.calls).toEqual([]);
    expect(JSON.stringify({ run, acceptance, priorEvidence, git: {
      head: stableGit.head(), dirty: stableGit.isDirty(), diffHash: stableGit.diffHash(), control: stableGit.controlStateHash(),
    } })).toBe(before);
  });
});
