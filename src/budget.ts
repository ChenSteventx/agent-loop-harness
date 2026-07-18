// Immutable per-run resource boundaries for content whose size the model or
// the target repository controls. Bound into RunBinding at run creation so a
// resume can never pick up different limits than the run started with.
//
// Step, repair, and timeout caps intentionally stay where they already live
// (routing templates and runtime configuration): duplicating them here would
// create a second source of truth.
export interface RunBudget {
  version: 1;
  // Tracked diff text (git diff --binary output) per collection.
  maximumDiffBytes: number;
  // Untracked-file capture inside the workspace diff.
  maximumUntrackedFiles: number;
  maximumUntrackedFileBytes: number;
  maximumUntrackedTotalBytes: number;
  // Serialized explorer advisory allowed into an Author prompt.
  maximumExplorerAdvisoryBytes: number;
  // Failure-evidence excerpt allowed into a repair prompt, per evidence item.
  maximumEvidenceExcerptBytes: number;
  // Final rendered prompt per provider invocation.
  maximumPromptBytes: number;
}

export function defaultRunBudget(): RunBudget {
  return {
    version: 1,
    maximumDiffBytes: 4 * 1024 * 1024,
    maximumUntrackedFiles: 500,
    maximumUntrackedFileBytes: 1024 * 1024,
    maximumUntrackedTotalBytes: 8 * 1024 * 1024,
    maximumExplorerAdvisoryBytes: 32 * 1024,
    maximumEvidenceExcerptBytes: 64 * 1024,
    maximumPromptBytes: 2 * 1024 * 1024,
  };
}

export function validateRunBudget(budget: RunBudget): RunBudget {
  for (const [name, value] of Object.entries(budget)) {
    if (name === "version") continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Run budget field ${name} must be a positive integer`);
    }
  }
  if (budget.version !== 1) throw new Error("Unsupported Run budget version");
  return budget;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly boundary: keyof Omit<RunBudget, "version">,
    readonly observed: number,
    readonly limit: number,
    detail: string,
  ) {
    super(`Run budget exceeded (${boundary}): ${detail} (${observed} > ${limit})`);
    this.name = "BudgetExceededError";
  }
}
