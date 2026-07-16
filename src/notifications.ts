import { appendFileSync } from "node:fs";
import type { EmailMessage, EmailTransport } from "./email.js";
import type { SqliteStore } from "./store.js";

export interface NotificationSink {
  deliver(message: string): void;
}

export class FileNotificationSink implements NotificationSink {
  constructor(private readonly path: string) {}

  deliver(message: string): void {
    appendFileSync(this.path, `${message}\n`, "utf8");
  }
}

export function deliverOutbox(store: SqliteStore, sink: NotificationSink): { delivered: number; failed: number } {
  let delivered = 0;
  let failed = 0;
  for (const item of store.listPendingOutbox()) {
    try {
      sink.deliver(JSON.stringify({ type: item.type, runId: item.runId, payload: item.payload }));
      store.markOutboxDelivered(item.id);
      delivered += 1;
    } catch (error) {
      store.markOutboxFailed(item.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { delivered, failed };
}

export interface NotificationDispatcherOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  batchSize: number;
}

export interface NotificationDispatchResult {
  delivered: number;
  retried: number;
  deadLettered: number;
}

export interface DispatchableNotification {
  id: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  deduplicationKey: string;
}

export interface NotificationOutbox {
  listDispatchableOutbox(now?: string, limit?: number): DispatchableNotification[];
  markOutboxDelivered(id: number, providerMessageId: string | null, now: string): void;
  scheduleOutboxRetry(id: number, error: string, nextAttemptAt: string, deadLetteredAt: string | null): void;
}

export const defaultNotificationDispatcherOptions: NotificationDispatcherOptions = {
  maxAttempts: 5,
  baseDelayMs: 60_000,
  maximumDelayMs: 3_600_000,
  batchSize: 100,
};

export class NotificationDispatcher {
  private readonly options: NotificationDispatcherOptions;

  constructor(
    private readonly store: NotificationOutbox,
    private readonly transport: EmailTransport,
    options: Partial<NotificationDispatcherOptions> = {},
  ) {
    this.options = { ...defaultNotificationDispatcherOptions, ...options };
    validateDispatcherOptions(this.options);
  }

  async dispatch(now = new Date().toISOString()): Promise<NotificationDispatchResult> {
    const result: NotificationDispatchResult = { delivered: 0, retried: 0, deadLettered: 0 };
    for (const item of this.store.listDispatchableOutbox(now, this.options.batchSize)) {
      try {
        const receipt = await this.transport.send(renderOutboxEmail(item));
        this.store.markOutboxDelivered(item.id, receipt.providerMessageId, now);
        result.delivered += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        const deadLetteredAt = attempts >= this.options.maxAttempts ? now : null;
        const nextAttemptAt = addMilliseconds(now, retryDelay(attempts, this.options));
        this.store.scheduleOutboxRetry(
          item.id,
          error instanceof Error ? error.message : String(error),
          nextAttemptAt,
          deadLetteredAt,
        );
        if (deadLetteredAt) result.deadLettered += 1;
        else result.retried += 1;
      }
    }
    return result;
  }
}

export function renderOutboxEmail(item: DispatchableNotification): EmailMessage {
  if (item.type === "metrics-digest" && isRenderedDigest(item.payload)) {
    return {
      idempotencyKey: item.deduplicationKey,
      subject: item.payload.subject,
      text: item.payload.text,
    };
  }
  return {
    idempotencyKey: item.deduplicationKey,
    subject: `[agent-loop] ${notificationLabel(item.type)}: ${item.runId}`,
    text: [
      `Event: ${item.type}`,
      `Run: ${item.runId}`,
      `Created: ${item.createdAt}`,
      `Idempotency-Key: ${item.deduplicationKey}`,
      "",
      JSON.stringify(item.payload, null, 2),
    ].join("\n"),
  };
}

function isRenderedDigest(value: unknown): value is { subject: string; text: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { subject?: unknown }).subject === "string" &&
    typeof (value as { text?: unknown }).text === "string";
}

function notificationLabel(type: string): string {
  const labels: Record<string, string> = {
    blocked: "Run blocked",
    "needs-human": "Human decision required",
    "provider-fallback": "Provider fallback used",
    ready: "Run ready for review",
    done: "Run completed",
    "proposal-created": "Change Proposal created",
    "evaluation-completed": "Evaluation completed",
    "shadow-ready": "Shadow result ready",
    "canary-started": "Canary started",
    "canary-promoted": "Canary promoted",
    "canary-rolled-back": "Canary rolled back",
    "memory-quarantined": "Candidate Memory quarantined",
    "memory-conflict": "Candidate Memory conflict",
    "metrics-digest": "Metrics digest",
  };
  return labels[type] ?? `Event ${type}`;
}

function retryDelay(attempts: number, options: NotificationDispatcherOptions): number {
  return Math.min(options.maximumDelayMs, options.baseDelayMs * (2 ** Math.max(attempts - 1, 0)));
}

function addMilliseconds(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Dispatcher timestamp is invalid");
  return new Date(timestamp + milliseconds).toISOString();
}

function validateDispatcherOptions(options: NotificationDispatcherOptions): void {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0 ||
      !Number.isSafeInteger(options.baseDelayMs) || options.baseDelayMs <= 0 ||
      !Number.isSafeInteger(options.maximumDelayMs) || options.maximumDelayMs < options.baseDelayMs ||
      !Number.isSafeInteger(options.batchSize) || options.batchSize <= 0 || options.batchSize > 1_000) {
    throw new Error("Notification Dispatcher options must be finite positive bounds");
  }
}
