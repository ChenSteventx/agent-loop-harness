import { operationInputHash } from "../bindings.js";
import type { SanitizedFactBundle } from "../evaluation/facts.js";

export const candidateMemoryStatuses = [
  "candidate", "evaluating", "approved", "rejected", "deprecated", "invalidated",
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
  repositoryScope: string;
  operationType: string;
  kind: CandidateMemoryKind;
  summary: string;
  terms: string[];
  contentHash: string;
  sourceFactHashes: string[];
  sourceRunIds: string[];
  sourceCommits: string[];
  evidenceRefs: string[];
  supportCount: number;
  status: CandidateMemoryStatus;
  createdAt: string;
  expiresAt: string;
  validatedAt: string | null;
  invalidationReason: string | null;
  preconditions: string[];
  counterexamples: string[];
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
  const groups = new Map<string, MemoryGroup>();
  for (const fact of facts.filter((item) => item.source === "real" && item.run.binding)) {
    const projectScope = fact.run.binding!.projectAdapterName;
    const failures = fact.evidence.filter((item) => item.kind === "verification_failure");
    if (failures.length > 0) {
      addGroup(groups, projectScope, "failure-pattern",
        `Failure signature in ${projectScope}; affected area is the bound project; useful tests are the recorded verification steps; root cause requires evidence`,
        fact, failures.map((item) => item.id));
    }
  }
  return [...groups.values()].map((group) => candidate({
    projectScope: group.projectScope,
    kind: group.kind,
    summary: group.summary,
    sourceFactHashes: [...group.facts].sort(),
    sourceRunIds: [...group.runs].sort(),
    sourceCommits: [...group.commits].sort(),
    evidenceRefs: [...group.evidence].sort(),
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
  const overfit = memory.supportCount < 2 || new Set(memory.sourceRunIds).size < 2;
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
    .filter((memory) => ["candidate", "evaluating", "approved"].includes(memory.status) && memory.expiresAt <= now)
    .map((memory) => repository.decideCandidateMemory({
      id: memory.id,
      status: "deprecated",
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
  sourceRunIds: string[];
  sourceCommits: string[];
  evidenceRefs: string[];
  now: string;
  expiresAt: string;
}): CandidateMemory {
  const terms = tokenize(input.summary);
  const contentHash = operationInputHash({
    projectScope: input.projectScope,
    repositoryScope: input.projectScope,
    operationType: "verification",
    kind: input.kind,
    summary: input.summary,
    terms,
  });
  return {
    schemaVersion: 1,
    id: `memory:${input.projectScope}:${input.kind}:${contentHash.slice(0, 16)}`,
    projectScope: input.projectScope,
    repositoryScope: input.projectScope,
    operationType: "verification",
    kind: input.kind,
    summary: input.summary,
    terms,
    contentHash,
    sourceFactHashes: input.sourceFactHashes,
    sourceRunIds: input.sourceRunIds,
    sourceCommits: input.sourceCommits,
    evidenceRefs: input.evidenceRefs,
    supportCount: input.sourceRunIds.length,
    status: "candidate",
    createdAt: input.now,
    expiresAt: input.expiresAt,
    validatedAt: null,
    invalidationReason: null,
    preconditions: ["same repository scope", "matching operation type", "current evidence remains valid"],
    counterexamples: [],
    decision: null,
  };
}

interface MemoryGroup {
  projectScope: string;
  kind: CandidateMemoryKind;
  summary: string;
  facts: Set<string>;
  runs: Set<string>;
  commits: Set<string>;
  evidence: Set<string>;
}

function addGroup(
  groups: Map<string, MemoryGroup>,
  projectScope: string,
  kind: CandidateMemoryKind,
  summary: string,
  fact: SanitizedFactBundle,
  evidenceRefs: readonly string[],
): void {
  const key = operationInputHash({ projectScope, kind, summary });
  const group = groups.get(key) ?? {
    projectScope, kind, summary, facts: new Set<string>(), runs: new Set<string>(),
    commits: new Set<string>(), evidence: new Set<string>(),
  };
  group.facts.add(fact.factHash);
  group.runs.add(fact.run.id);
  for (const commit of fact.evidence.map((item) => item.commitSha).filter(Boolean)) group.commits.add(commit);
  for (const reference of evidenceRefs) group.evidence.add(`${fact.run.id}:${reference}`);
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
