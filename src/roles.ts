import type { TaskSpec } from "./task-spec.js";

export const agentRoles = ["author", "explorer", "reviewer"] as const;
export type AgentRole = (typeof agentRoles)[number];

export function assertCoreMayCreateAgent(parent: "core" | AgentRole): void {
  if (parent !== "core") throw new Error(`${parent} Agent cannot create a child Agent`);
}

export interface AuthorPromptOptions {
  variant?: string;
  memoryAdvisory?: string | null;
}

// Hard boundary every Author variant carries verbatim: variants may change
// authoring strategy, never the safety contract.
const authorBoundaryLines = [
  "Work only in the current worktree. Edit files only; do not run git add, git commit, or change Git metadata.",
  "Leave a non-empty working diff for the Harness to inspect and commit deterministically.",
  "Return only a concise summary and the changedFiles array required by the Author output schema.",
];

type AuthorPromptBuilder = (task: TaskSpec, advisories: string[]) => string;

// Bounded registry: a configuration variant may only select a template that
// exists here. Unregistered names are rejected at proposal creation and, as
// defence in depth, throw at prompt time instead of silently falling back.
const authorPromptBuilders: Record<string, AuthorPromptBuilder> = {
  baseline: (task, advisories) => [
    `Task: ${task.id}`,
    `Goal: ${task.goal}`,
    "Acceptance:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...advisories,
    ...authorBoundaryLines,
  ].join("\n"),
  "acceptance-first": (task, advisories) => [
    "Acceptance criteria to satisfy, in priority order:",
    ...task.acceptance.map((item, index) => `${index + 1}. ${item}`),
    `Task: ${task.id}`,
    `Goal: ${task.goal}`,
    "Before editing, identify the smallest set of files that satisfies every criterion, then make only those edits.",
    ...advisories,
    ...authorBoundaryLines,
  ].join("\n"),
};

export const authorPromptVariants: readonly string[] = Object.freeze(Object.keys(authorPromptBuilders));

// Single source for the Author instructions: the Orchestrator (formal runs)
// and the full-task replay executor (evaluation runs) must issue the same
// prompt for the same configuration, or comparisons would measure prompt
// drift instead of configuration.
export function authorPrompt(
  task: TaskSpec,
  explorerAdvisory: string | null,
  options: AuthorPromptOptions = {},
): string {
  const variant = options.variant ?? "baseline";
  const builder = authorPromptBuilders[variant];
  if (!builder) throw new Error(`Unregistered author prompt variant: ${variant}`);
  return builder(task, [
    ...(explorerAdvisory ? [`Explorer advisory report: ${explorerAdvisory}`] : []),
    ...(options.memoryAdvisory ? [`Approved memory advisory: ${options.memoryAdvisory}`] : []),
  ]);
}
