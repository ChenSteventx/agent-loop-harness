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

export interface ProjectAdapter {
  readonly name: string;
  readonly policyVersion: string;
  minimumRisk(input: {
    task: TaskSpec;
    changedFiles?: readonly string[];
  }): Risk;
  verificationCommands(task: TaskSpec): readonly VerificationCommand[];
  postMergeCommands(task: TaskSpec): readonly VerificationCommand[];
  allowDiagnosticCommand?(request: FindingVerificationRequest): boolean;
}
