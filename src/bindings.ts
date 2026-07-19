import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceDependencies, RunBinding } from "./domain.js";
import type { ProjectAdapter } from "./ports.js";
import { routeRisk, type ExecutionTemplateName, type Risk } from "./routing.js";
import type { TaskSpec } from "./task-spec.js";
import { boundAdvisoryText, defaultRunBudget, validateRunBudget, type RunBudget } from "./budget.js";
import { defaultRuntimeConfiguration, type RuntimeConfiguration } from "./runtime-config.js";

export interface CreateRunBindingInput {
  taskSpecPath: string;
  taskSpec: TaskSpec;
  baselineCommit: string;
  sourceRepository: string;
  worktreePath: string;
  providerProfile: string;
  projectAdapter: ProjectAdapter;
  effectiveRisk?: Risk;
  executionTemplate?: ExecutionTemplateName;
  runtimeConfiguration?: RuntimeConfiguration;
  budget?: RunBudget;
  memoryAdvisory?: string | null;
}

export function createRunBinding(input: CreateRunBindingInput): RunBinding {
  const effectiveRisk = input.effectiveRisk ?? input.taskSpec.risk;
  const runtime = input.runtimeConfiguration ?? defaultRuntimeConfiguration();
  const budget = validateRunBudget(input.budget ?? defaultRunBudget());
  return {
    version: 1,
    taskSpecPath: normalizeExistingPath(input.taskSpecPath),
    taskSpec: input.taskSpec,
    taskSpecHash: taskSpecHash(input.taskSpec),
    acceptanceHash: acceptanceHash(input.taskSpec.acceptance),
    baselineCommit: input.baselineCommit,
    sourceRepository: normalizeExistingPath(input.sourceRepository),
    worktreePath: resolve(input.worktreePath),
    risk: effectiveRisk,
    // A requested template must still cover the effective risk: routeRisk
    // throws when the single candidate sits below the risk's minimum, so an
    // explicit template can escalate (e.g. review a low-risk run) but never
    // downgrade the routed floor.
    executionTemplate: input.executionTemplate
      ? routeRisk(effectiveRisk, [input.executionTemplate])
      : routeRisk(effectiveRisk),
    providerProfile: requiredText(input.providerProfile, "providerProfile"),
    projectAdapterName: requiredText(input.projectAdapter.name, "projectAdapter.name"),
    policyVersion: requiredText(input.projectAdapter.policyVersion, "projectAdapter.policyVersion"),
    configurationVariantId: runtime.configurationVariantId,
    configurationHash: runtime.configurationHash,
    canaryAssignmentId: runtime.canaryAssignmentId,
    configSource: runtime.configSource,
    runtimeConfiguration: runtime.configuration,
    budget,
    memoryAdvisory: boundAdvisoryText(input.memoryAdvisory ?? null, budget.maximumExplorerAdvisoryBytes),
  };
}

export function evidenceDependencies(input: Omit<EvidenceDependencies, "version">): EvidenceDependencies {
  return { version: 1, ...input };
}

export function evidenceDependencyHash(dependencies: EvidenceDependencies): string {
  return sha256(canonicalJson(dependencies));
}

export function operationInputHash(input: unknown): string {
  return sha256(canonicalJson(input));
}

export function taskSpecHash(task: TaskSpec): string {
  return sha256(canonicalJson(task));
}

export function acceptanceHash(acceptance: readonly string[]): string {
  return sha256(canonicalJson(acceptance));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalValue(child);
    }
    return result;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeExistingPath(path: string): string {
  const absolute = realpathSync(resolve(path));
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
