import { createHash } from "node:crypto";
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

// Deterministically bound a JSON payload: within the limit it serializes
// as-is; beyond it, a truncation envelope preserves identity (sha256 of the
// full serialization) and a leading excerpt so the full artifact stays
// traceable without entering memory-sensitive paths.
export function boundedJson(value: unknown, maximumBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= maximumBytes) return serialized;
  const identity = {
    truncated: true as const,
    originalBytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
  // The excerpt shrinks until the whole envelope fits: JSON escaping can
  // inflate the excerpt well beyond its character count, so the envelope is
  // measured after serialization, not estimated. Slicing by characters keeps
  // the excerpt an exact prefix of the serialized payload.
  let excerptLength = Math.min(serialized.length, maximumBytes);
  while (excerptLength > 0) {
    const envelope = JSON.stringify({ ...identity, excerpt: serialized.slice(0, excerptLength) });
    if (Buffer.byteLength(envelope) <= maximumBytes) return envelope;
    excerptLength = Math.floor(excerptLength / 2);
  }
  // Floor: even an empty excerpt cannot fit under a tiny limit; the bare
  // envelope (~200 bytes) is the minimum honest representation.
  return JSON.stringify({ ...identity, excerpt: "" });
}

// Advisory text is model input, not evidence: an oversized advisory is
// truncated by bytes (a torn trailing code point decodes to a replacement
// character, which is harmless in a prompt) rather than failing the run.
export function boundAdvisoryText(text: string | null, maximumBytes: number): string | null {
  if (text === null) return null;
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maximumBytes) return text;
  return encoded.subarray(0, Math.max(maximumBytes, 0)).toString("utf8");
}

export function assertPromptWithinBudget(prompt: string, maximumBytes: number | undefined, role: string): void {
  if (maximumBytes === undefined) return;
  const observed = Buffer.byteLength(prompt);
  if (observed > maximumBytes) {
    throw new BudgetExceededError("maximumPromptBytes", observed, maximumBytes, `${role} prompt`);
  }
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
