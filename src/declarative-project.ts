import { readFileSync } from "node:fs";
import { z } from "zod";
import { operationInputHash } from "./bindings.js";
import { isImmutableImageDigest } from "./execution.js";
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
  verificationImage: z.string().trim().refine(isImmutableImageDigest, {
    message: "must be an immutable repository reference pinned by @sha256:<64 lowercase hex>",
  }),
  // Substring/segment patterns whose presence in the task scope or changed
  // files raises the minimum risk to high. Required: "nothing is sensitive"
  // must be an explicit [] in the config, never an accidental omission.
  sensitivePathSegments: z.array(z.string().trim().min(1).max(256)).max(200),
  // Normalize a leading "node" argv entry for the configured container image.
  // Host executable paths are never copied into contained command specs.
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
  readonly verificationImageDigest: string;

  constructor(private readonly config: DeclarativeProjectConfig) {
    this.name = config.name;
    this.verificationImageDigest = config.verificationImage;
    // The effective policy version is content-addressed: the run binding
    // freezes it, and the resume-time drift gate compares it against the
    // live adapter — so editing the config file between attempts (same
    // declared version, different segments) blocks the run instead of
    // silently reclassifying risk.
    this.policyVersion = `${config.policyVersion}#${operationInputHash(config).slice(0, 12)}`;
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
    const normalized = canonicalPathText(path);
    return this.config.sensitivePathSegments.some((segment) =>
      normalized.includes(canonicalPathText(segment)));
  }

  private normalize(command: VerificationCommand): VerificationCommand {
    if (!this.config.rewriteNodeCommands || command.argv[0] !== "node") return command;
    return { ...command, argv: ["node", ...command.argv.slice(1)] };
  }
}

// Unicode-normalized (NFC) so an NFD path from Git matches an NFC-typed
// config segment; separator and case folding as in the generic adapter.
function canonicalPathText(text: string): string {
  return text.normalize("NFC").replace(/\\/gu, "/").toLowerCase();
}
