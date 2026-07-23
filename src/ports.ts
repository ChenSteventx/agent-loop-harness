import type { TaskSpec } from "./task-spec.js";
import type { Risk } from "./routing.js";

export interface VerificationCommand {
  id: string;
  argv: [string, ...string[]];
}

export interface FindingVerificationRequest {
  verificationStepId?: string;
  proposedArgv?: [string, ...string[]];
  expectedExitCode?: number;
  stdoutIncludes?: string;
  stderrIncludes?: string;
}

export interface FindingValidationPlan {
  id: string;
  command: VerificationCommand;
  expected: {
    exitCode?: number;
    stdoutIncludes?: string;
    stderrIncludes?: string;
  };
  diagnosticSafe: true;
}

export interface FindingValidationContext {
  task: TaskSpec;
  finding: {
    id: string;
    category: string;
    severity: string;
    claim: string;
    location: string;
  };
  request: FindingVerificationRequest;
}

export interface ProjectAdapter {
  readonly name: string;
  readonly policyVersion: string;
  readonly verificationImageDigest?: string | null;
  minimumRisk(input: {
    task: TaskSpec;
    changedFiles?: readonly string[];
  }): Risk;
  verificationCommands(task: TaskSpec): readonly VerificationCommand[];
  postMergeCommands(task: TaskSpec): readonly VerificationCommand[];
  resolveFindingValidation?(context: FindingValidationContext): FindingValidationPlan | null;
  /** @deprecated Prefer resolveFindingValidation(), which owns both command and predicate. */
  allowDiagnosticCommand?(request: FindingVerificationRequest): boolean;
}
