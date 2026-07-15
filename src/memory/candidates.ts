import { operationInputHash } from "../bindings.js";
import type { SanitizedFactBundle } from "../evaluation/facts.js";

export const candidateMemoryStatuses = [
  "candidate", "approved", "rejected", "superseded", "expired", "invalidated",
] as const;
export type CandidateMemoryStatus = (typeof candidateMemoryStatuses)[number];
export type CandidateMemoryKind = "failure-pattern" | "finding-rule" | "provider-observation";

export const candidateMemoryDefaults = Object.freeze({
  captureCandidates: true,
  retrievalMode: "off" as const,
  autoPromote: false,
  crossProject: false,
});

export interface CandidateMemory {
  schemaVersion: 1;
  id: string;
  projectScope: string;
  kind: CandidateMemoryKind;
  summary: string;
  terms: string[];
  contentHash: string;
  sourceFactHashes: string[];
  supportCount: number;
  status: CandidateMemoryStatus;
  createdAt: string;
  expiresAt: string;
  decision: null | {
    status: Exclude<CandidateMemoryStatus, "candidate">;
    authority: "human" | "system-expiry";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  };
}

export interface MemoryRepository {
  installCandidateMemory(memory: CandidateMemory): CandidateMemory;
  getCandidateMemory(id: string): CandidateMemory | null;
  listCandidateMemories(projectScope?: string): CandidateMemory[];
  decideCandidateMemory(input: {
    id: string;
    status: Exclude<CandidateMemoryStatus, "candidate">;
    authority: "human" | "system-expiry";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  }): CandidateMemory;
}

export interface MemoryScanReport {
  passed: boolean;
  secretMarkers: string[];
  absolutePaths: string[];
  forbiddenIdentifiers: string[];
  overfit: boolean;
}

export function deriveCandidateMemories(
  facts: readonly SanitizedFactBundle[],
  options: { now?: string; ttlDays?: number } = {},
): CandidateMemory[] {
  const now = options.now ?? new Date().toISOString();
  const expiresAt = addDays(now, options.ttlDays ?? 90);
  const groups = new Map<string, { projectScope: string; kind: CandidateMemoryKind; summary: string; facts: Set<string> }>();
  for (const fact of facts.filter((item) => item.source === "real" && item.run.binding)) {
    const projectScope = fact.run.binding!.projectAdapterName;
    for (const failureClass of ["quota", "rate_limit"] as const) {
      if (fact.events.some((event) => event.type === "provider.failure" && event.failureClass === failureClass)) {
        addGroup(groups, projectScope, "provider-observation",
          `Provider ${failureClass} failures require bounded fallback evidence`, fact.factHash);
      }
    }
    if (fact.evidence.some((item) => item.kind === "verification_failure")) {
      addGroup(groups, projectScope, "failure-pattern",
        "Verification failure evidence must be repaired and re-verified on the bound commit", fact.factHash);
    }
    for (const finding of fact.reviewerFindings.filter((item) => item.authority === "human")) {
      addGroup(groups, projectScope, "finding-rule",
        `${finding.category} ${finding.severity} Findings require independent machine or human resolution`, fact.factHash);
    }
  }
  return [...groups.values()].map((group) => candidate({
    projectScope: group.projectScope,
    kind: group.kind,
    summary: group.summary,
    sourceFactHashes: [...group.facts].sort(),
    now,
    expiresAt,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function scanCandidateMemory(
  memory: CandidateMemory,
  options: { forbiddenIdentifiers?: readonly string[] } = {},
): MemoryScanReport {
  const source = `${memory.summary}\n${memory.terms.join(" ")}`;
  const lower = source.toLowerCase();
  const secretMarkers = ["authorization", "bearer ", "api_key", "api-key", "access_token", "refresh_token", "password="]
    .filter((marker) => lower.includes(marker));
  const absolutePaths = source.match(/(?:[A-Z]:[\\/][^\s]+|\/(?:home|Users|mnt|private|var)\/[^\s]+)/giu) ?? [];
  const forbiddenIdentifiers = (options.forbiddenIdentifiers ?? [])
    .filter((identifier) => identifier.trim().length > 0 && lower.includes(identifier.toLowerCase()));
  const overfit = memory.supportCount < 2 || new Set(memory.sourceFactHashes).size < 2;
  return {
    passed: secretMarkers.length === 0 && absolutePaths.length === 0 && forbiddenIdentifiers.length === 0 && !overfit,
    secretMarkers,
    absolutePaths,
    forbiddenIdentifiers,
    overfit,
  };
}

export function approveCandidateMemory(
  repository: MemoryRepository,
  input: { id: string; approvedBy: string; reason: string; decidedAt?: string; forbiddenIdentifiers?: readonly string[] },
): CandidateMemory {
  const memory = requireMemory(repository, input.id);
  const scan = scanCandidateMemory(memory, { forbiddenIdentifiers: input.forbiddenIdentifiers });
  if (!scan.passed) throw new Error(`Candidate Memory ${input.id} failed approval scans`);
  return repository.decideCandidateMemory({
    id: input.id,
    status: "approved",
    authority: "human",
    decidedBy: requiredText(input.approvedBy, "human approver"),
    reason: requiredText(input.reason, "approval reason"),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  });
}

export function rejectCandidateMemory(
  repository: MemoryRepository,
  input: { id: string; rejectedBy: string; reason: string; decidedAt?: string },
): CandidateMemory {
  requireMemory(repository, input.id);
  return repository.decideCandidateMemory({
    id: input.id,
    status: "rejected",
    authority: "human",
    decidedBy: requiredText(input.rejectedBy, "human reviewer"),
    reason: requiredText(input.reason, "rejection reason"),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  });
}

export function invalidateCandidateMemory(
  repository: MemoryRepository,
  input: { id: string; invalidatedBy: string; reason: string; decidedAt?: string },
): CandidateMemory {
  requireMemory(repository, input.id);
  return repository.decideCandidateMemory({
    id: input.id,
    status: "invalidated",
    authority: "human",
    decidedBy: requiredText(input.invalidatedBy, "human reviewer"),
    reason: requiredText(input.reason, "invalidation reason"),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  });
}

export function expireCandidateMemories(
  repository: MemoryRepository,
  now = new Date().toISOString(),
): CandidateMemory[] {
  return repository.listCandidateMemories()
    .filter((memory) => (memory.status === "candidate" || memory.status === "approved") && memory.expiresAt <= now)
    .map((memory) => repository.decideCandidateMemory({
      id: memory.id,
      status: "expired",
      authority: "system-expiry",
      decidedBy: "candidate-memory-expiry",
      reason: "Candidate Memory reached its explicit expiry time",
      decidedAt: now,
    }));
}

export function retrieveApprovedMemory(
  repository: MemoryRepository,
  input: { projectScope: string; query: string; enabled?: boolean; now?: string; limit?: number },
): Array<{ memory: CandidateMemory; score: number; matchedTerms: string[] }> {
  if (input.enabled !== true) return [];
  const now = input.now ?? new Date().toISOString();
  const queryTerms = tokenize(input.query);
  if (queryTerms.length === 0) return [];
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 20) throw new Error("Memory retrieval limit must be between 1 and 20");
  return repository.listCandidateMemories(input.projectScope)
    .filter((memory) => memory.status === "approved" && memory.expiresAt > now && memory.projectScope === input.projectScope)
    .map((memory) => {
      const matchedTerms = memory.terms.filter((term) => queryTerms.includes(term));
      return { memory, score: matchedTerms.length / Math.max(memory.terms.length, 1), matchedTerms };
    })
    .filter((result) => result.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id))
    .slice(0, limit);
}

function candidate(input: {
  projectScope: string;
  kind: CandidateMemoryKind;
  summary: string;
  sourceFactHashes: string[];
  now: string;
  expiresAt: string;
}): CandidateMemory {
  const terms = tokenize(input.summary);
  const contentHash = operationInputHash({
    projectScope: input.projectScope,
    kind: input.kind,
    summary: input.summary,
    terms,
  });
  return {
    schemaVersion: 1,
    id: `memory:${input.projectScope}:${input.kind}:${contentHash.slice(0, 16)}`,
    projectScope: input.projectScope,
    kind: input.kind,
    summary: input.summary,
    terms,
    contentHash,
    sourceFactHashes: input.sourceFactHashes,
    supportCount: input.sourceFactHashes.length,
    status: "candidate",
    createdAt: input.now,
    expiresAt: input.expiresAt,
    decision: null,
  };
}

function addGroup(
  groups: Map<string, { projectScope: string; kind: CandidateMemoryKind; summary: string; facts: Set<string> }>,
  projectScope: string,
  kind: CandidateMemoryKind,
  summary: string,
  factHash: string,
): void {
  const key = operationInputHash({ projectScope, kind, summary });
  const group = groups.get(key) ?? { projectScope, kind, summary, facts: new Set<string>() };
  group.facts.add(factHash);
  groups.set(key, group);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_-]+/u).filter((term) => term.length >= 3))].sort();
}

function requireMemory(repository: MemoryRepository, id: string): CandidateMemory {
  const memory = repository.getCandidateMemory(id);
  if (!memory) throw new Error(`Candidate Memory not found: ${id}`);
  return memory;
}

function addDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error("Candidate Memory TTL must be a positive integer");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Candidate Memory timestamp is invalid");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}
