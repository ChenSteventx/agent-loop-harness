import type { TaskSpec } from "./task-spec.js";

export interface VerificationCommand {
  id: string;
  argv: [string, ...string[]];
}

export interface ProjectAdapter {
  readonly name: string;
  readonly policyVersion: string;
  verificationCommands(task: TaskSpec): readonly VerificationCommand[];
  postMergeCommands(task: TaskSpec): readonly VerificationCommand[];
}
