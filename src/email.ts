import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { connect as connectNet, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";

export interface EmailMessage {
  idempotencyKey: string;
  subject: string;
  text: string;
}

export interface EmailSendReceipt {
  providerMessageId: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendReceipt>;
}

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfiguration {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  from: string;
  recipients: string[];
  timeoutMs: number;
}

export class SmtpEmailTransport implements EmailTransport {
  constructor(private readonly configuration: SmtpConfiguration) {
    validateConfiguration(configuration);
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): SmtpEmailTransport {
    const host = requiredEnvironment(environment, "AGENT_LOOP_SMTP_HOST");
    const security = parseSecurity(environment.AGENT_LOOP_SMTP_SECURITY ?? "starttls");
    const defaultPort = security === "tls" ? 465 : 587;
    const port = parsePositiveInteger(environment.AGENT_LOOP_SMTP_PORT ?? String(defaultPort), "SMTP port");
    const username = optionalEnvironment(environment, "AGENT_LOOP_SMTP_USERNAME");
    const password = optionalEnvironment(environment, "AGENT_LOOP_SMTP_PASSWORD");
    if ((username === null) !== (password === null)) {
      throw new Error("SMTP username and password must be supplied together");
    }
    return new SmtpEmailTransport({
      host,
      port,
      security,
      username,
      password,
      from: requiredEnvironment(environment, "AGENT_LOOP_EMAIL_FROM"),
      recipients: requiredEnvironment(environment, "AGENT_LOOP_EMAIL_TO")
        .split(",").map((value) => value.trim()).filter(Boolean),
      timeoutMs: parsePositiveInteger(environment.AGENT_LOOP_SMTP_TIMEOUT_MS ?? "15000", "SMTP timeout"),
    });
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    validateMessage(message);
    const messageId = stableMessageId(message.idempotencyKey, this.configuration.host);
    let socket = await openSocket(this.configuration);
    let session = new SmtpSession(socket);
    try {
      await session.expect([220]);
      await session.command(`EHLO ${smtpHostname()}`, [250]);
      if (this.configuration.security === "starttls") {
        await session.command("STARTTLS", [220]);
        session.dispose();
        socket = await upgradeSocket(socket, this.configuration);
        session = new SmtpSession(socket);
        await session.command(`EHLO ${smtpHostname()}`, [250]);
      }
      if (this.configuration.username && this.configuration.password) {
        const credentials = Buffer.from(`\0${this.configuration.username}\0${this.configuration.password}`, "utf8")
          .toString("base64");
        await session.command(`AUTH PLAIN ${credentials}`, [235]);
      }
      await session.command(`MAIL FROM:<${this.configuration.from}>`, [250]);
      for (const recipient of this.configuration.recipients) {
        await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
      }
      await session.command("DATA", [354]);
      await session.data(renderRfc822(this.configuration, message, messageId));
      try {
        await session.command("QUIT", [221]);
      } catch {
        // Delivery has already been acknowledged; a QUIT failure must not turn it into a retry.
      }
      return { providerMessageId: messageId };
    } finally {
      session.dispose();
      socket.destroy();
    }
  }
}

class SmtpSession {
  private buffer = "";
  private current: string[] = [];
  private readonly queued: string[][] = [];
  private readonly waiting: Array<{ resolve: (lines: string[]) => void; reject: (error: Error) => void }> = [];
  private readonly onData = (chunk: Buffer) => this.accept(chunk.toString("utf8"));
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("SMTP connection closed"));

  constructor(private readonly socket: Duplex) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  async expect(expected: readonly number[]): Promise<string[]> {
    const lines = await this.read();
    const code = Number(lines.at(-1)?.slice(0, 3));
    if (!expected.includes(code)) throw new Error(`SMTP expected ${expected.join("/")} but received ${lines.join(" | ")}`);
    return lines;
  }

  async command(value: string, expected: readonly number[]): Promise<string[]> {
    this.socket.write(`${value}\r\n`);
    return this.expect(expected);
  }

  async data(value: string): Promise<string[]> {
    const escaped = value.split("\r\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
    this.socket.write(`${escaped}\r\n.\r\n`);
    return this.expect([250]);
  }

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  private read(): Promise<string[]> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private accept(value: string): void {
    this.buffer += value;
    while (this.buffer.includes("\r\n")) {
      const end = this.buffer.indexOf("\r\n");
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.current.push(line);
      if (/^\d{3} /u.test(line)) {
        const response = this.current;
        this.current = [];
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(response);
        else this.queued.push(response);
      }
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
}

async function openSocket(configuration: SmtpConfiguration): Promise<Socket | TLSSocket> {
  if (configuration.security === "tls") {
    const socket = connectTls({ host: configuration.host, port: configuration.port, servername: configuration.host });
    await waitForConnection(socket, "secureConnect", configuration.timeoutMs);
    return socket;
  }
  const socket = connectNet({ host: configuration.host, port: configuration.port });
  await waitForConnection(socket, "connect", configuration.timeoutMs);
  return socket;
}

async function upgradeSocket(socket: Duplex, configuration: SmtpConfiguration): Promise<TLSSocket> {
  const secure = connectTls({ socket, servername: configuration.host });
  await waitForConnection(secure, "secureConnect", configuration.timeoutMs);
  return secure;
}

function waitForConnection(socket: Duplex, event: "connect" | "secureConnect", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy(new Error("SMTP connection timed out"));
      reject(new Error("SMTP connection timed out"));
    }, timeoutMs);
    const onConnected = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onConnected);
      socket.off("error", onError);
    };
    socket.once(event, onConnected);
    socket.once("error", onError);
  });
}

function renderRfc822(configuration: SmtpConfiguration, message: EmailMessage, messageId: string): string {
  const subject = safeHeader(message.subject, "email subject");
  const text = message.text.replace(/\r?\n/gu, "\r\n");
  return [
    `From: ${configuration.from}`,
    `To: ${configuration.recipients.join(", ")}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `X-Agent-Loop-Idempotency-Key: ${safeHeader(message.idempotencyKey, "idempotency key")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].join("\r\n");
}

function validateConfiguration(configuration: SmtpConfiguration): void {
  safeHeader(configuration.host, "SMTP host");
  validateAddress(configuration.from, "sender");
  if (configuration.recipients.length === 0) throw new Error("At least one email recipient is required");
  for (const recipient of configuration.recipients) validateAddress(recipient, "recipient");
  if (!Number.isSafeInteger(configuration.port) || configuration.port <= 0 || configuration.port > 65_535 ||
      !Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs <= 0) {
    throw new Error("SMTP port and timeout must be positive integers");
  }
  if ((configuration.username === null) !== (configuration.password === null)) {
    throw new Error("SMTP username and password must be supplied together");
  }
}

function validateMessage(message: EmailMessage): void {
  safeHeader(message.idempotencyKey, "idempotency key");
  safeHeader(message.subject, "email subject");
  if (!message.text.trim()) throw new Error("Email text is required");
}

function validateAddress(value: string, label: string): void {
  safeHeader(value, label);
  if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(value)) throw new Error(`Invalid email ${label}`);
}

function safeHeader(value: string, label: string): string {
  if (!value.trim() || /[\r\n]/u.test(value)) throw new Error(`${label} is required and cannot contain newlines`);
  return value;
}

function stableMessageId(idempotencyKey: string, host: string): string {
  return `<agent-loop-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}@${host}>`;
}

function smtpHostname(): string {
  return hostname().replace(/[^a-zA-Z0-9.-]/gu, "-") || "agent-loop";
}

function parseSecurity(value: string): SmtpSecurity {
  if (value === "tls" || value === "starttls" || value === "none") return value;
  throw new Error("AGENT_LOOP_SMTP_SECURITY must be tls, starttls, or none");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnvironment(environment, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function optionalEnvironment(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}
