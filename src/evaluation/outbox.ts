export const evolutionOutboxEventTypes = [
  "proposal-created",
  "evaluation-completed",
  "shadow-ready",
  "canary-started",
  "canary-promoted",
  "canary-rolled-back",
  "memory-quarantined",
  "memory-conflict",
  "metrics-digest",
] as const;

export type EvolutionOutboxEventType = (typeof evolutionOutboxEventTypes)[number];

export interface EvolutionOutboxEvent {
  id: number;
  runId: string;
  projectScope: string;
  type: EvolutionOutboxEventType;
  payload: unknown;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  deduplicationKey: string;
  deadLetteredAt: string | null;
  providerMessageId: string | null;
}
