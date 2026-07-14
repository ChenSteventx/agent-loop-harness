import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { ProjectAdapter, VerificationCommand } from "./ports.js";
import { parseTaskSpec, type TaskSpec } from "./task-spec.js";

export function loadTaskSpec(path: string): TaskSpec {
  return parseTaskSpec(parse(readFileSync(path, "utf8")) as unknown);
}

export class GenericNodeProjectAdapter implements ProjectAdapter {
  readonly name = "generic-node";

  constructor(readonly policyVersion = "generic-node/v1") {}

  verificationCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map(normalizeNodeCommand);
  }

  postMergeCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map(normalizeNodeCommand);
  }
}

function normalizeNodeCommand(command: VerificationCommand): VerificationCommand {
  return {
    ...command,
    argv: [command.argv[0] === "node" ? process.execPath : command.argv[0], ...command.argv.slice(1)],
  };
}
