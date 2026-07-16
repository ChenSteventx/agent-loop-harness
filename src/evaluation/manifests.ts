import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../bindings.js";
import type { RunBinding } from "../domain.js";
import type { VerificationCommand } from "../ports.js";
import type { ProviderIdentity } from "../provider.js";

export type InvocationRole = "explorer" | "author" | "repair" | "reviewer";
export type Replayability = "manifest-complete" | "verify-only" | "partial" | "none";

export interface InvocationManifest {
  schemaVersion: 1;
  id: string;
  runId: string;
  operationId: string;
  role: InvocationRole;
  harness: {
    packageVersion: string;
    sourceCommit: string | null;
  };
  prompt: {
    templateId: string;
    templateVersion: string;
    templateHash: string;
    renderedPromptHash: string;
    redactedArtifactPath: string | null;
  };
  outputSchemaHash: string;
  provider: {
    configuredProvider: string;
    configuredModel: string | null;
    actualProvider: string;
    actualModel: string | null;
    actualFamily: string | null;
    adapterVersion: string | null;
  };
  inputs: {
    taskSpecHash: string;
    acceptanceHash: string;
    policyVersion: string;
    baselineCommit: string;
    currentCommit: string;
    verificationPlanHash: string;
    configurationVariantId: string | null;
    configurationHash: string | null;
    canaryAssignmentId: string | null;
    configSource: RunBinding["configSource"];
  };
  context: Array<{
    kind: string;
    reference: string;
    contentHash: string;
    trust: "trusted" | "project" | "untrusted";
  }>;
  environment: {
    platform: string;
    arch: string;
    nodeVersion: string;
    packageManager: string | null;
    lockfileHash: string | null;
  };
  createdAt: string;
}

export interface ManifestContextInput {
  kind: string;
  reference: string;
  content: unknown;
  trust: "trusted" | "project" | "untrusted";
}

export interface CreateInvocationManifestInput {
  id: string;
  runId: string;
  operationId: string;
  role: InvocationRole;
  binding: RunBinding;
  renderedPrompt: string;
  outputSchemaPath: string;
  configuredProvider: { provider: string; model: string | null };
  actualProvider: ProviderIdentity;
  currentCommit: string;
  verificationPlan: readonly VerificationCommand[];
  context?: readonly ManifestContextInput[];
  createdAt?: string;
}

export interface ReplayabilityReport {
  grade: Replayability;
  missingInputs: string[];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageMetadata = readPackageMetadata();

export function createInvocationManifest(input: CreateInvocationManifestInput): InvocationManifest {
  const templateId = `agent-loop/${input.role}`;
  const templateVersion = "1";
  return {
    schemaVersion: 1,
    id: requiredText(input.id, "manifest id"),
    runId: requiredText(input.runId, "run id"),
    operationId: requiredText(input.operationId, "operation id"),
    role: input.role,
    harness: {
      packageVersion: packageMetadata.version,
      sourceCommit: harnessSourceCommit(),
    },
    prompt: {
      templateId,
      templateVersion,
      templateHash: sha256(canonicalJson({ templateId, templateVersion })),
      renderedPromptHash: sha256(input.renderedPrompt),
      redactedArtifactPath: null,
    },
    outputSchemaHash: fileHash(input.outputSchemaPath),
    provider: {
      configuredProvider: requiredText(input.configuredProvider.provider, "configured provider"),
      configuredModel: input.configuredProvider.model,
      actualProvider: requiredText(input.actualProvider.provider, "actual provider"),
      actualModel: input.actualProvider.model,
      actualFamily: input.actualProvider.modelFamily ?? null,
      adapterVersion: input.actualProvider.version,
    },
    inputs: {
      taskSpecHash: input.binding.taskSpecHash,
      acceptanceHash: input.binding.acceptanceHash,
      policyVersion: input.binding.policyVersion,
      baselineCommit: input.binding.baselineCommit,
      currentCommit: requiredText(input.currentCommit, "current commit"),
      verificationPlanHash: sha256(canonicalJson(input.verificationPlan)),
      configurationVariantId: input.binding.configurationVariantId,
      configurationHash: input.binding.configurationHash,
      canaryAssignmentId: input.binding.canaryAssignmentId,
      configSource: input.binding.configSource,
    },
    context: (input.context ?? []).map((item) => ({
      kind: requiredText(item.kind, "context kind"),
      reference: requiredText(item.reference, "context reference"),
      contentHash: sha256(canonicalJson(item.content)),
      trust: item.trust,
    })),
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      packageManager: packageMetadata.packageManager,
      lockfileHash: fileHashOrNull(resolve(repositoryRoot, "package-lock.json")),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function gradeReplayability(input: {
  binding: RunBinding | null;
  manifests: readonly InvocationManifest[];
  requiredOperationIds?: readonly string[];
}): ReplayabilityReport {
  const missing = new Set<string>();
  if (!input.binding) {
    return { grade: "none", missingInputs: ["run_binding"] };
  }
  if (input.manifests.length === 0) {
    missing.add("invocation_manifests");
    missing.add("prompt_hashes");
    missing.add("provider_identity");
    missing.add("context_manifest");
    missing.add("environment_fingerprint");
    return {
      grade: input.binding.taskSpec.verification.length > 0 ? "verify-only" : "partial",
      missingInputs: [...missing],
    };
  }
  const requiredOperationIds = input.requiredOperationIds ?? [];
  for (const operationId of requiredOperationIds) {
    if (!input.manifests.some((manifest) => manifest.operationId === operationId)) {
      missing.add(`invocation_manifest:${operationId}`);
    }
  }
  for (const manifest of input.manifests) {
    if (!manifest.harness.sourceCommit) missing.add(`harness_source_commit:${manifest.id}`);
    if (!manifest.prompt.templateHash || !manifest.prompt.renderedPromptHash) missing.add(`prompt_hashes:${manifest.id}`);
    if (!manifest.outputSchemaHash) missing.add(`output_schema_hash:${manifest.id}`);
    if (!manifest.provider.actualProvider) missing.add(`provider_identity:${manifest.id}`);
    if (!manifest.provider.actualModel) missing.add(`provider_model:${manifest.id}`);
    if (!manifest.provider.adapterVersion) missing.add(`provider_version:${manifest.id}`);
    if (!manifest.inputs.verificationPlanHash) missing.add(`verification_plan_hash:${manifest.id}`);
    if (manifest.context.length === 0) missing.add(`context_manifest:${manifest.id}`);
    if (!manifest.environment.platform || !manifest.environment.arch || !manifest.environment.nodeVersion) {
      missing.add(`environment_fingerprint:${manifest.id}`);
    }
    if (!manifest.environment.packageManager || !manifest.environment.lockfileHash) {
      missing.add(`dependency_fingerprint:${manifest.id}`);
    }
  }
  if (missing.size === 0) return { grade: "manifest-complete", missingInputs: [] };
  return {
    grade: input.binding.taskSpec.verification.length > 0 ? "verify-only" : "partial",
    missingInputs: [...missing].sort(),
  };
}

export function manifestContainsSensitiveMaterial(manifest: InvocationManifest): boolean {
  const serialized = canonicalJson(manifest).toLowerCase();
  return ["authorization", "bearer ", "api_key", "api-key", "access_token", "refresh_token", "password="]
    .some((marker) => serialized.includes(marker));
}

function readPackageMetadata(): { version: string; packageManager: string | null } {
  try {
    const value = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return {
      version: typeof value.version === "string" ? value.version : "unknown",
      packageManager: typeof value.packageManager === "string" ? value.packageManager : null,
    };
  } catch {
    return { version: "unknown", packageManager: null };
  }
}

function harnessSourceCommit(): string | null {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function fileHash(path: string): string {
  return sha256(readFileSync(resolve(path)));
}

function fileHashOrNull(path: string): string | null {
  return existsSync(path) ? fileHash(path) : null;
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
