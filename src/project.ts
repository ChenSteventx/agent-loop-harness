import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { operationInputHash } from "./bindings.js";
import { isImmutableImageDigest } from "./execution.js";
import type { ProjectAdapter, VerificationCommand } from "./ports.js";
import type { Risk } from "./routing.js";
import { parseTaskSpec, type TaskSpec } from "./task-spec.js";

export function loadTaskSpec(path: string): TaskSpec {
  return parseTaskSpec(parse(readFileSync(path, "utf8")) as unknown);
}

export class GenericNodeProjectAdapter implements ProjectAdapter {
  readonly name = "generic-node";
  readonly policyVersion: string;

  constructor(
    basePolicyVersion = "generic-node/v2",
    readonly verificationImageDigest: string | null = null,
  ) {
    if (verificationImageDigest !== null && !isImmutableImageDigest(verificationImageDigest)) {
      throw new Error("Generic Node verification image must be pinned by @sha256 digest");
    }
    this.policyVersion = verificationImageDigest === null
      ? basePolicyVersion
      : `${basePolicyVersion}#oci-${operationInputHash(verificationImageDigest).slice(0, 12)}`;
  }

  minimumRisk(input: { task: TaskSpec; changedFiles?: readonly string[] }): Risk {
    const paths = input.changedFiles ?? input.task.scope ?? [];
    return paths.some(isSensitivePath) ? "high" : "low";
  }

  verificationCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map(normalizeNodeCommand);
  }

  postMergeCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map(normalizeNodeCommand);
  }
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  return /(^|\/)(?:security|auth|authentication|authorization|permissions?|access-control|crypto|secrets?|billing)(?:\/|$)/u
    .test(normalized) || /^\.github\/workflows(?:\/|$)/u.test(normalized);
}

function normalizeNodeCommand(command: VerificationCommand): VerificationCommand {
  return {
    ...command,
    argv: [command.argv[0] === "node" ? "node" : command.argv[0], ...command.argv.slice(1)],
  };
}
