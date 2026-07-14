export const runStatuses = [
  "open",
  "ready",
  "merged",
  "done",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof runStatuses)[number];
export type ActiveRunStatus = "open" | "ready" | "merged";

export interface BlockedRunMetadata {
  previousStatus: ActiveRunStatus;
  reason: string;
  checkpointRef: string;
  resumeCommand: string;
}

export interface Run {
  id: string;
  taskId: string;
  binding: RunBinding | null;
  status: RunStatus;
  blocked: BlockedRunMetadata | null;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunBinding {
  version: 1;
  taskSpecPath: string;
  taskSpec: import("./task-spec.js").TaskSpec;
  taskSpecHash: string;
  acceptanceHash: string;
  baselineCommit: string;
  sourceRepository: string;
  worktreePath: string;
  risk: import("./routing.js").Risk;
  executionTemplate: import("./routing.js").ExecutionTemplateName;
  providerProfile: string;
  projectAdapterName: string;
  policyVersion: string;
}

export type OperationStatus = "running" | "succeeded" | "failed";

export interface Operation {
  id: string;
  runId: string;
  kind: string;
  idempotencyKey: string;
  input: unknown | null;
  inputHash: string | null;
  status: OperationStatus;
  result: unknown | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EvidenceDependencies {
  version: 1;
  commitSha: string;
  taskSpecHash: string;
  acceptanceHash: string;
  policyVersion: string;
  stepId: string;
  operationInputHash: string;
}

export type EvidenceStatus = "valid" | "invalid";

export interface Evidence {
  id: string;
  runId: string;
  operationId: string | null;
  kind: string;
  status: EvidenceStatus;
  commitSha: string;
  policyVersion: string;
  stepId: string;
  dependencyHash: string;
  dependencyVersion: 1 | null;
  dependencies: EvidenceDependencies | null;
  data: unknown;
  createdAt: string;
  invalidatedAt: string | null;
}

export interface Event {
  id: number;
  runId: string;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface TransitionOptions {
  now?: string;
  blocked?: Omit<BlockedRunMetadata, "previousStatus">;
  mergeSha?: string;
}

const normalNext: Record<ActiveRunStatus, RunStatus> = {
  open: "ready",
  ready: "merged",
  merged: "done",
};

export function createRun(
  id: string,
  taskId: string,
  now = new Date().toISOString(),
  binding: RunBinding | null = null,
): Run {
  return {
    id,
    taskId,
    binding,
    status: "open",
    blocked: null,
    mergeSha: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionRun(run: Run, target: RunStatus, options: TransitionOptions = {}): Run {
  if (!isActive(run.status)) {
    throw new Error(`Cannot transition terminal run from ${run.status} to ${target}`);
  }

  const isNormal = normalNext[run.status] === target;
  const isTerminal = target === "blocked" || target === "failed" || target === "cancelled";
  if (!isNormal && !isTerminal) {
    throw new Error(`Illegal run transition: ${run.status} -> ${target}`);
  }

  let blocked: BlockedRunMetadata | null = null;
  if (target === "blocked") {
    if (!options.blocked?.reason || !options.blocked.checkpointRef || !options.blocked.resumeCommand) {
      throw new Error("Blocked transition requires reason, checkpointRef, and resumeCommand");
    }
    blocked = { previousStatus: run.status, ...options.blocked };
  }

  if (target === "merged" && !options.mergeSha) {
    throw new Error("Merged transition requires a mergeSha");
  }

  return {
    ...run,
    status: target,
    blocked,
    mergeSha: target === "merged" ? options.mergeSha! : run.mergeSha,
    updatedAt: options.now ?? new Date().toISOString(),
  };
}

export function resumeBlockedRun(run: Run, now = new Date().toISOString()): Run {
  if (run.status !== "blocked" || !run.blocked) {
    throw new Error("Only a blocked run can be resumed");
  }
  return { ...run, status: run.blocked.previousStatus, blocked: null, updatedAt: now };
}

export function reopenReadyRun(run: Run, now = new Date().toISOString()): Run {
  if (run.status !== "ready") throw new Error("Only a ready run can be reopened for invalid evidence");
  return { ...run, status: "open", updatedAt: now };
}

function isActive(status: RunStatus): status is ActiveRunStatus {
  return status === "open" || status === "ready" || status === "merged";
}
