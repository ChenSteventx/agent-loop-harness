import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ProjectAdapter, VerificationCommand } from "./ports.js";
import type { Risk } from "./routing.js";
import type { TaskSpec } from "./task-spec.js";

// Declarative project entry: most projects need only a name, a policy
// version, and their risk-sensitive paths — no TypeScript adapter. The
// config deliberately cannot express anything the ProjectAdapter port does
// not already allow: no Git metadata authority, no verdicts, no promotion.
const declarativeProjectConfigSchema = z.object({
  name: z.string().trim().min(1).max(128),
  policyVersion: z.string().trim().min(1).max(128),
  // Substring/segment patterns whose presence in the task scope or changed
  // files raises the minimum risk to high.
  sensitivePathSegments: z.array(z.string().trim().min(1).max(256)).max(200).default([]),
  // Rewrite a leading "node" argv entry to the current Node executable —
  // what the built-in generic-node adapter does. Off for non-Node projects.
  rewriteNodeCommands: z.boolean().default(false),
}).strict();

export type DeclarativeProjectConfig = z.infer<typeof declarativeProjectConfigSchema>;

export function loadDeclarativeProjectConfig(path: string): DeclarativeProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Project config is unreadable or not JSON: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = declarativeProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Project config is invalid: ${path}: ${result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

export class DeclarativeProjectAdapter implements ProjectAdapter {
  readonly name: string;
  readonly policyVersion: string;

  constructor(private readonly config: DeclarativeProjectConfig) {
    this.name = config.name;
    this.policyVersion = config.policyVersion;
  }

  minimumRisk(input: { task: TaskSpec; changedFiles?: readonly string[] }): Risk {
    const paths = input.changedFiles ?? input.task.scope ?? [];
    return paths.some((path) => this.isSensitive(path)) ? "high" : "low";
  }

  verificationCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map((command) => this.normalize(command));
  }

  postMergeCommands(task: TaskSpec): readonly VerificationCommand[] {
    return task.verification.map((command) => this.normalize(command));
  }

  private isSensitive(path: string): boolean {
    const normalized = path.replace(/\\/gu, "/").toLowerCase();
    return this.config.sensitivePathSegments.some((segment) =>
      normalized.includes(segment.replace(/\\/gu, "/").toLowerCase()));
  }

  private normalize(command: VerificationCommand): VerificationCommand {
    if (!this.config.rewriteNodeCommands || command.argv[0] !== "node") return command;
    return { ...command, argv: [process.execPath, ...command.argv.slice(1)] };
  }
}
