import { appendFileSync } from "node:fs";
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
