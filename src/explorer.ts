import { z } from "zod";
import { assertPromptWithinBudget, boundedJson } from "./budget.js";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./provider.js";
import type { TaskSpec } from "./task-spec.js";

const referenceSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  symbols: z.array(z.string().trim().min(1).max(300)).max(100),
}).strict();

const evidenceSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  observation: z.string().trim().min(1).max(2000),
}).strict();

export const explorerReportSchema = z.object({
  relevantFiles: z.array(referenceSchema).max(200),
  likelyAffectedTests: z.array(z.string().trim().min(1).max(1024)).max(200),
  evidence: z.array(evidenceSchema).max(200),
  importantUnknowns: z.array(z.string().trim().min(1).max(2000)).max(100),
}).strict();

export type ExplorerReport = z.infer<typeof explorerReportSchema>;

export interface ExplorerInput {
  task: TaskSpec;
  baselineCommit: string;
  currentCommit: string;
  allowedRepositoryRoots: readonly string[];
  contextBudget: number;
}

export interface ExplorerResult {
  report: ExplorerReport | null;
  provider: ProviderRunResult;
  renderedPrompt: string;
  costTokens: number;
  latencyMs: number;
  used: boolean;
}

export async function runExplorer(
  provider: ProviderAdapter,
  input: ExplorerInput,
  request: Omit<ProviderRunRequest, "prompt" | "workspaceAccess" | "allowedRepositoryRoots" | "contextBudget" | "additionalWritableDirectories">,
): Promise<ExplorerResult> {
  if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget <= 0) {
    throw new Error("Explorer context budget must be a positive integer");
  }
  const renderedPrompt = renderExplorerPrompt(input);
  assertPromptWithinBudget(renderedPrompt, request.maximumPromptBytes, "explorer");
  const providerResult = await provider.run({
    ...request,
    prompt: renderedPrompt,
    workspaceAccess: "read-only",
    allowedRepositoryRoots: input.allowedRepositoryRoots,
    contextBudget: input.contextBudget,
  });
  const parsed = providerResult.ok
    ? explorerReportSchema.safeParse(providerResult.finalOutput)
    : null;
  const report = parsed?.success ? parsed.data : null;
  return {
    report,
    provider: providerResult,
    renderedPrompt,
    costTokens: sumUsage(providerResult),
    latencyMs: providerResult.durationMs,
    used: report !== null,
  };
}

export function compactExplorerReport(report: ExplorerReport, maximumBytes: number): string {
  return boundedJson(report, maximumBytes);
}

export function renderExplorerPrompt(input: ExplorerInput): string {
  return [
    "Role: bounded read-only Explorer. Do not write files or change run state.",
    `Task spec: ${JSON.stringify(input.task)}`,
    `Baseline commit: ${input.baselineCommit}`,
    `Current commit: ${input.currentCommit}`,
    `Allowed repository roots: ${JSON.stringify(input.allowedRepositoryRoots)}`,
    `Context budget: ${input.contextBudget}`,
    "Return only relevantFiles, likelyAffectedTests, evidence, and importantUnknowns.",
  ].join("\n");
}

function sumUsage(result: ProviderRunResult): number {
  return (result.usage?.inputTokens ?? 0) +
    (result.usage?.outputTokens ?? 0);
}
