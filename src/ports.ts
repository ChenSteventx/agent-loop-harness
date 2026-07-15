import type { TaskSpec } from "./task-spec.js";
import type { Risk } from "./routing.js";

export interface VerificationCommand {
  id: string;
  argv: [string, ...string[]];
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
}
