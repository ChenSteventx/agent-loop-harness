import { operationInputHash } from "../bindings.js";
import type { Event, Evidence, Operation, Run } from "../domain.js";
import type { InvocationManifest } from "./manifests.js";

export type FactSourceKind = "real" | "fixture";

export interface FactHumanResolution {
  type: "finding";
  findingId: string;
  outcome: "confirmed" | "rejected";
  note: string | null;
}

export interface FactHumanInbox {
  id: number;
  runId: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: FactHumanResolution | null;
}

export interface FactAgentCall {
  id: number;
  runId: string;
  role: string;
  provider: string;
  latencyMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

export interface DevelopmentFactSource {
  getRun(runId: string): Run | null;
  listOperations(runId: string): Operation[];
  listEvidence(runId: string): Evidence[];
  listEvents(runId: string): Event[];
  listInvocationManifests(runId: string): InvocationManifest[];
  listHumanInbox(runId: string): FactHumanInbox[];
  listAgentCalls(runId: string): FactAgentCall[];
}

export interface ReviewerFindingFact {
  id: string;
  category: string;
  severity: string;
  outcome: "confirmed" | "rejected" | "inconclusive" | "unresolved";
  authority: "machine" | "human" | "none";
}

export interface SanitizedFactBundle {
  schemaVersion: 1;
  source: FactSourceKind;
  exportedAt: string;
  factHash: string;
  run: {
    id: string;
    taskId: string;
    status: Run["status"];
    mergeSha: string | null;
    createdAt: string;
    updatedAt: string;
    binding: null | {
      taskSpecHash: string;
      acceptanceHash: string;
      baselineCommit: string;
      risk: string;
      executionTemplate: string;
      providerProfile: string;
      projectAdapterName: string;
      policyVersion: string;
      verificationStepIds: string[];
    };
  };
  operations: Array<{
    id: string;
    kind: string;
    status: Operation["status"];
    inputHash: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  evidence: Array<{
    id: string;
    kind: string;
    status: Evidence["status"];
    commitSha: string;
    policyVersion: string;
    stepId: string;
    dependencyHash: string;
    createdAt: string;
    invalidatedAt: string | null;
    findingValidation: null | {
      findingId: string;
      outcome: "confirmed" | "rejected" | "inconclusive";
    };
  }>;
  events: Array<{
    id: number;
    type: string;
    createdAt: string;
    failureClass: string | null;
  }>;
  manifests: InvocationManifest[];
  human: Array<{
    id: number;
    createdAt: string;
    resolvedAt: string | null;
    resolution: Omit<FactHumanResolution, "note"> | null;
  }>;
  agentCalls: FactAgentCall[];
  reviewerFindings: ReviewerFindingFact[];
}

export function exportRunFacts(
  source: DevelopmentFactSource,
  runId: string,
  options: { source?: FactSourceKind; exportedAt?: string } = {},
): SanitizedFactBundle {
  const run = source.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const operations = source.listOperations(runId);
  const evidence = source.listEvidence(runId);
  const events = source.listEvents(runId);
  const human = source.listHumanInbox(runId);
  const reviewerFindings = reviewerFindingFacts(operations, evidence, human);
  const withoutHash = {
    schemaVersion: 1 as const,
    source: options.source ?? "real",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    run: {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      mergeSha: run.mergeSha,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      binding: run.binding ? {
        taskSpecHash: run.binding.taskSpecHash,
        acceptanceHash: run.binding.acceptanceHash,
        baselineCommit: run.binding.baselineCommit,
        risk: run.binding.risk,
        executionTemplate: run.binding.executionTemplate,
        providerProfile: run.binding.providerProfile,
        projectAdapterName: run.binding.projectAdapterName,
        policyVersion: run.binding.policyVersion,
        verificationStepIds: run.binding.taskSpec.verification.map((step) => step.id),
      } : null,
    },
    operations: operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      inputHash: operation.inputHash,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
    })),
    evidence: evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      commitSha: item.commitSha,
      policyVersion: item.policyVersion,
      stepId: item.stepId,
      dependencyHash: item.dependencyHash,
      createdAt: item.createdAt,
      invalidatedAt: item.invalidatedAt,
      findingValidation: findingValidationFact(item.data),
    })),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      failureClass: event.type === "provider.failure" ? recordText(event.data, "failureClass") : null,
    })),
    manifests: source.listInvocationManifests(runId),
    human: human.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt,
      resolution: item.resolution ? {
        type: item.resolution.type,
        findingId: item.resolution.findingId,
        outcome: item.resolution.outcome,
      } : null,
    })),
    agentCalls: source.listAgentCalls(runId),
    reviewerFindings,
  };
  const { exportedAt: _exportedAt, ...stableFacts } = withoutHash;
  return { ...withoutHash, factHash: operationInputHash(stableFacts) };
}

function reviewerFindingFacts(
  operations: readonly Operation[],
  evidence: readonly Evidence[],
  human: readonly FactHumanInbox[],
): ReviewerFindingFact[] {
  const machine = new Map<string, ReviewerFindingFact["outcome"]>();
  for (const item of evidence) {
    const fact = findingValidationFact(item.data);
    if (item.kind === "finding_validation" && item.status === "valid" && fact) {
      machine.set(fact.findingId, fact.outcome);
    }
  }
  const resolved = new Map<string, FactHumanResolution["outcome"]>();
  for (const item of human) {
    if (item.resolution?.type === "finding") resolved.set(item.resolution.findingId, item.resolution.outcome);
  }
  const findings = new Map<string, Omit<ReviewerFindingFact, "outcome" | "authority">>();
  for (const operation of operations.filter((item) => item.kind === "reviewer")) {
    const report = recordValue(operation.result, "report");
    const values = report && Array.isArray(report.findings) ? report.findings : [];
    for (const value of values) {
      if (!isRecord(value)) continue;
      const id = recordText(value, "id");
      const category = recordText(value, "category");
      const severity = recordText(value, "severity");
      if (id && category && severity) findings.set(id, { id, category, severity });
    }
  }
  return [...findings.values()].map((finding): ReviewerFindingFact => {
    const humanOutcome = resolved.get(finding.id);
    const machineOutcome = machine.get(finding.id);
    return {
      ...finding,
      outcome: humanOutcome ?? machineOutcome ?? "unresolved",
      authority: humanOutcome ? "human" : machineOutcome ? "machine" : "none",
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function findingValidationFact(value: unknown): SanitizedFactBundle["evidence"][number]["findingValidation"] {
  if (!isRecord(value)) return null;
  const findingId = recordText(value, "findingId");
  const status = recordText(value, "status");
  if (!findingId || (status !== "confirmed" && status !== "rejected" && status !== "inconclusive")) return null;
  return { findingId, outcome: status };
}

function recordValue(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function recordText(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
