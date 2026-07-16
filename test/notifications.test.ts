import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailTransport } from "../src/email.js";
import { SmtpEmailTransport } from "../src/email.js";
import { deliverOutbox, FileNotificationSink, NotificationDispatcher } from "../src/notifications.js";
import { SqliteStore } from "../src/store.js";

const directories: string[] = [];
function fixture() { const directory = mkdtempSync(join(tmpdir(), "notifications-")); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class FakeEmailTransport implements EmailTransport {
  readonly messages: EmailMessage[] = [];
  failuresRemaining = 0;

  async send(message: EmailMessage) {
    this.messages.push(message);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("fake SMTP unavailable");
    }
    return { providerMessageId: `fake:${message.idempotencyKey}` };
  }
}

describe("outbox notification delivery", () => {
  it("delivers pending records to a local file", () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1");
    store.transitionRun("run-1", "ready", {}, { commit: "abc" });
    expect(deliverOutbox(store, new FileNotificationSink(join(directory, "notifications.log")))).toEqual({ delivered: 1, failed: 0 });
    expect(readFileSync(join(directory, "notifications.log"), "utf8")).toContain('"type":"ready"');
    expect(store.listPendingOutbox()).toHaveLength(0);
    store.close();
  });

  it("does not alter the development result when delivery fails", () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1");
    store.transitionRun("run-1", "ready");
    expect(deliverOutbox(store, { deliver() { throw new Error("disk unavailable"); } })).toEqual({ delivered: 0, failed: 1 });
    expect(store.getRun("run-1")?.status).toBe("ready");
    expect(store.listPendingOutbox()[0]).toMatchObject({ attempts: 1, lastError: "disk unavailable" });
    store.close();
  });

  it("dispatches each idempotency key once and records the provider message id", async () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1", "2026-07-15T00:00:00.000Z");
    const events = ["blocked", "needs-human", "provider-fallback", "ready", "done"] as const;
    for (const type of events) {
      const first = store.enqueueOutbox("run-1", type, { type }, "2026-07-15T00:00:01.000Z", `mail:${type}`);
      const repeated = store.enqueueOutbox("run-1", type, { type }, "2026-07-15T00:00:02.000Z", `mail:${type}`);
      expect(repeated.id).toBe(first.id);
    }
    expect(() => store.enqueueOutbox(
      "run-1", "ready", { different: true }, "2026-07-15T00:00:03.000Z", "mail:ready",
    )).toThrow("different content");
    const transport = new FakeEmailTransport();
    const dispatcher = new NotificationDispatcher(store, transport);
    expect(await dispatcher.dispatch("2026-07-15T00:01:00.000Z"))
      .toEqual({ delivered: 5, retried: 0, deadLettered: 0 });
    expect(await dispatcher.dispatch("2026-07-15T00:02:00.000Z"))
      .toEqual({ delivered: 0, retried: 0, deadLettered: 0 });
    expect(transport.messages).toHaveLength(5);
    expect(store.getOutbox(1)).toMatchObject({ providerMessageId: "fake:mail:blocked", attempts: 1 });
    expect(store.outboxStatus("2026-07-15T00:02:00.000Z"))
      .toEqual({ pending: 0, dispatchable: 0, delivered: 5, deadLettered: 0 });
    store.close();
  });

  it("uses bounded exponential retry and dead letters without changing Run or Evidence", async () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1", "2026-07-15T00:00:00.000Z");
    store.transitionRun("run-1", "ready", { now: "2026-07-15T00:00:01.000Z" });
    const before = JSON.stringify({ run: store.getRun("run-1"), evidence: store.listEvidence("run-1") });
    const transport = new FakeEmailTransport();
    transport.failuresRemaining = 2;
    const dispatcher = new NotificationDispatcher(store, transport, {
      maxAttempts: 2, baseDelayMs: 1_000, maximumDelayMs: 8_000, batchSize: 10,
    });
    expect(await dispatcher.dispatch("2026-07-15T00:00:01.000Z"))
      .toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
    expect(store.listPendingOutbox()[0]).toMatchObject({
      attempts: 1, nextAttemptAt: "2026-07-15T00:00:02.000Z", deadLetteredAt: null,
    });
    expect(await dispatcher.dispatch("2026-07-15T00:00:01.999Z"))
      .toEqual({ delivered: 0, retried: 0, deadLettered: 0 });
    expect(await dispatcher.dispatch("2026-07-15T00:00:02.000Z"))
      .toEqual({ delivered: 0, retried: 0, deadLettered: 1 });
    expect(store.listDeadLetterOutbox()).toEqual([
      expect.objectContaining({ attempts: 2, deadLetteredAt: "2026-07-15T00:00:02.000Z" }),
    ]);
    expect(JSON.stringify({ run: store.getRun("run-1"), evidence: store.listEvidence("run-1") })).toBe(before);
    store.close();
  });

  it("loads SMTP endpoints, sender, recipients, and credentials only from the supplied environment", () => {
    expect(() => SmtpEmailTransport.fromEnvironment({})).toThrow("AGENT_LOOP_SMTP_HOST");
    expect(SmtpEmailTransport.fromEnvironment({
      AGENT_LOOP_SMTP_HOST: "smtp.example.invalid",
      AGENT_LOOP_SMTP_PORT: "465",
      AGENT_LOOP_SMTP_SECURITY: "tls",
      AGENT_LOOP_SMTP_USERNAME: "secret-user",
      AGENT_LOOP_SMTP_PASSWORD: "secret-password",
      AGENT_LOOP_EMAIL_FROM: "loop@example.invalid",
      AGENT_LOOP_EMAIL_TO: "operator@example.invalid,reviewer@example.invalid",
    })).toBeInstanceOf(SmtpEmailTransport);
    expect(() => SmtpEmailTransport.fromEnvironment({
      AGENT_LOOP_SMTP_HOST: "smtp.example.invalid",
      AGENT_LOOP_SMTP_SECURITY: "none",
      AGENT_LOOP_SMTP_USERNAME: "plaintext-user",
      AGENT_LOOP_SMTP_PASSWORD: "plaintext-password",
      AGENT_LOOP_EMAIL_FROM: "loop@example.invalid",
      AGENT_LOOP_EMAIL_TO: "operator@example.invalid",
    })).toThrow("requires TLS or STARTTLS");
  });
});
