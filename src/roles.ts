import type { TaskSpec } from "./task-spec.js";

export const agentRoles = ["author", "explorer", "reviewer"] as const;
export type AgentRole = (typeof agentRoles)[number];

export function assertCoreMayCreateAgent(parent: "core" | AgentRole): void {
  if (parent !== "core") throw new Error(`${parent} Agent cannot create a child Agent`);
}

// Single source for the Author instructions: the Orchestrator (formal runs)
// and the full-task replay executor (evaluation runs) must issue the same
// prompt, or comparisons would measure prompt drift instead of configuration.
export function authorPrompt(task: TaskSpec, explorerAdvisory: string | null): string {
  return [
    `Task: ${task.id}`,
    `Goal: ${task.goal}`,
    "Acceptance:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...(explorerAdvisory ? [`Explorer advisory report: ${explorerAdvisory}`] : []),
    "Work only in the current worktree. Edit files only; do not run git add, git commit, or change Git metadata.",
    "Leave a non-empty working diff for the Harness to inspect and commit deterministically.",
    "Return only a concise summary and the changedFiles array required by the Author output schema.",
  ].join("\n");
}
