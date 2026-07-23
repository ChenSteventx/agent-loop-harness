import { createHash } from "node:crypto";
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
import type {
  FindingValidationContext,
  FindingValidationPlan,
  ProjectAdapter,
  VerificationCommand,
} from "../src/ports.js";
import type { Finding } from "../src/reviewer.js";
import type { TaskSpec } from "../src/task-spec.js";
import {
  containedCommandExpectation,
  containedCommandResult,
  fakeOciImage,
} from "./oci-fixture.js";

const commit = "a".repeat(40);
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

  constructor(
    private readonly commands: readonly VerificationCommand[],
    private readonly resolver?: (context: FindingValidationContext) => FindingValidationPlan | null,
  ) {}

  minimumRisk() { return "high" as const; }
  verificationCommands() { return this.commands; }
  postMergeCommands() { return this.commands; }
  resolveFindingValidation(context: FindingValidationContext) { return this.resolver?.(context) ?? null; }
}

class RecordingRunner {
  calls: CommandRequest[] = [];

  constructor(
    private readonly result?: (request: CommandRequest) => CommandResult,
    private readonly containment: { imageDigest: string; containmentSpecHash: string } | null = {
      imageDigest: fakeOciImage,
      containmentSpecHash: "1".repeat(64),
    },
  ) {}

  configurationBinding() {
    return this.containment;
  }

  receiptExpectation(request: CommandRequest) {
    if (!this.containment) throw new Error("OCI containment unavailable");
    return {
      ...containedCommandExpectation(request, commit),
      imageDigest: this.containment.imageDigest,
      containmentSpecHash: this.containment.containmentSpecHash,
    };
  }

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

function resultWithOutput(
  request: CommandRequest,
  stdout: string,
  stderr: string,
  exitCode: number,
  truncated: { stdout?: boolean; stderr?: boolean } = {},
): CommandResult {
  const stdoutPath = join(request.artifactDirectory, "stdout.log");
  const stderrPath = join(request.artifactDirectory, "stderr.log");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  return containedCommandResult(request, commit, {
    exitCode,
    stdoutPath,
    stderrPath,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutTruncated: truncated.stdout ?? false,
    stderrTruncated: truncated.stderr ?? false,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validationPlan(
  command: VerificationCommand,
  expected: FindingValidationPlan["expected"],
): FindingValidationPlan {
  return { id: `validate:${command.id}`, command, expected, diagnosticSafe: true };
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
      validationPlan: null,
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
    const machineResult: CommandResult = containedCommandResult({
      argv: command.argv,
      cwd: "/repo",
      artifactDirectory: "/artifacts",
      policyVersion: "test/v1",
      configurationHash: null,
    }, commit, {
      exitCode: 2,
      stdoutPath: "/artifacts/stdout.log",
      stderrPath: "/artifacts/stderr.log",
      stdoutHash: sha256(""),
      stderrHash: sha256("authorization bypass reproduced"),
    });
    const matchingEvidence = evidence({
      id: "E-FAILURE",
      kind: "verification_failure",
      stepId: "verification-failure:security-check",
      data: {
        commandId: command.id,
        argv: command.argv,
        result: machineResult,
        receiptExpectation: containedCommandExpectation({
          argv: command.argv,
          cwd: "/repo",
          artifactDirectory: "/artifacts",
          policyVersion: "test/v1",
          configurationHash: null,
        }, commit),
        stdout: "",
        stderr: "authorization bypass reproduced",
      },
    });
    const runner = new RecordingRunner();
    const validator = new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { exitCode: 2, stderrIncludes: "bypass reproduced" }),
    ), runner);

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
    const decision = await new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { exitCode: 0 }),
    ), runner).validate(input(finding({
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

  it("does not execute a diagnostic when OCI containment has no immutable binding", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner(
      (request) => resultWithOutput(request, "reproduced", "", 0),
      null,
    );
    const decision = await new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { stdoutIncludes: "reproduced" }),
    ), runner).validate(input(finding({
      verificationRequest: {
        verificationStepId: command.id,
        proposedArgv: command.argv,
        stdoutIncludes: "reproduced",
      },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("OCI containment");
    expect(runner.calls).toEqual([]);
  });

  it.each(["curl", "rm", "python"])("never executes a diagnostic without a Project Adapter plan (%s)", async (executable) => {
    const runner = new RecordingRunner();
    const decision = await new FindingValidator(new Adapter(task.verification), runner).validate(input(finding({
      verificationRequest: { proposedArgv: [executable, "unsafe"], stdoutIncludes: "reproduced" },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("did not provide");
    expect(runner.calls).toEqual([]);
  });

  it("does not let a Reviewer-selected common output predicate confirm a security claim", async () => {
    const command: VerificationCommand = { id: "typecheck", argv: ["npm", "run", "typecheck"] };
    const runner = new RecordingRunner((request) => resultWithOutput(request, "passed\n", "", 0));
    const decision = await new FindingValidator(new Adapter([command]), runner).validate(input(finding({
      verificationRequest: {
        verificationStepId: command.id,
        proposedArgv: command.argv,
        expectedExitCode: 0,
        stdoutIncludes: "passed",
      },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.validationPlan).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  it("uses the Project Adapter command and predicate instead of the Reviewer predicate", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner((request) => resultWithOutput(
      request,
      "",
      "security finding reproduced\n",
      2,
    ));
    const validator = new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { exitCode: 2, stderrIncludes: "security finding reproduced" }),
    ), runner);
    const request = {
      verificationStepId: command.id,
      proposedArgv: command.argv,
      expectedExitCode: 2,
      stderrIncludes: "Reviewer chose an unrelated predicate",
    };

    expect((await validator.validate(input(finding({ verificationRequest: request })))).status).toBe("confirmed");
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects when the machine output does not satisfy the Project Adapter plan", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner((request) => resultWithOutput(request, "", "different defect\n", 2));
    const validator = new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { exitCode: 2, stderrIncludes: "security finding reproduced" }),
    ), runner);

    const decision = await validator.validate(input(finding({
      verificationRequest: { verificationStepId: command.id, stderrIncludes: "different defect" },
    })));

    expect(decision.status).toBe("rejected");
    expect(decision.predicateEvaluation).toMatchObject({ matched: false, inconclusive: false });
  });

  it.each([
    { stream: "stdout" as const, stdout: "", stderr: "", truncated: { stdout: true } },
    { stream: "stderr" as const, stdout: "", stderr: "", truncated: { stderr: true } },
  ])("returns inconclusive when a required $stream predicate may be outside truncated output", async ({ stream, stdout, stderr, truncated }) => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const expected = stream === "stdout" ? { stdoutIncludes: "needle" } : { stderrIncludes: "needle" };
    const runner = new RecordingRunner((request) => resultWithOutput(request, stdout, stderr, 0, truncated));
    const validator = new FindingValidator(new Adapter([command], () => validationPlan(command, expected)), runner);

    const decision = await validator.validate(input(finding({
      verificationRequest: { verificationStepId: command.id, [`${stream}Includes`]: "Reviewer value" },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.predicateEvaluation).toMatchObject({ matched: false, inconclusive: true });
  });

  it("can confirm a predicate already found in truncated output", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner((request) => resultWithOutput(request, "needle before limit", "", 0, { stdout: true }));
    const validator = new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { exitCode: 0, stdoutIncludes: "needle" }),
    ), runner);

    const decision = await validator.validate(input(finding({
      verificationRequest: { verificationStepId: command.id, stdoutIncludes: "ignored" },
    })));

    expect(decision.status).toBe("confirmed");
    expect(decision.predicateEvaluation).toMatchObject({ matched: true, inconclusive: false });
  });

  it("treats diagnostic output that does not match its receipt hash as inconclusive", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const runner = new RecordingRunner((request) => ({
      ...resultWithOutput(request, "needle", "", 0),
      stdoutHash: sha256("different bytes"),
    }));
    const validator = new FindingValidator(new Adapter(
      [command],
      () => validationPlan(command, { stdoutIncludes: "needle" }),
    ), runner);

    const decision = await validator.validate(input(finding({
      verificationRequest: { verificationStepId: command.id, stdoutIncludes: "needle" },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("hashes");
    expect(decision.predicateEvaluation?.observed.stdoutReceiptMatched).toBe(false);
  });

  it("does not execute a plan without diagnosticSafe true", async () => {
    const command: VerificationCommand = { id: "security-check", argv: ["verify", "--check"] };
    const unsafePlan = { ...validationPlan(command, { stdoutIncludes: "needle" }), diagnosticSafe: false } as unknown as FindingValidationPlan;
    const runner = new RecordingRunner();
    const validator = new FindingValidator(new Adapter([command], () => unsafePlan), runner);

    const decision = await validator.validate(input(finding({
      verificationRequest: { verificationStepId: command.id, stdoutIncludes: "needle" },
    })));

    expect(decision.status).toBe("inconclusive");
    expect(decision.reason).toContain("not explicitly diagnostic-safe");
    expect(runner.calls).toEqual([]);
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
