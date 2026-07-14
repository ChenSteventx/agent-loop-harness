import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderFailureClass,
  ProviderIdentity,
  ProviderProbe,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderUsage,
} from "./provider.js";
import { classifyProviderFailure } from "./provider.js";

export interface ClaudeCodeAdapterConfig {
  executable?: string;
  baseArgs?: readonly string[];
  model?: string | null;
  modelFamily?: string | null;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  cancellationGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
}

const CAPABILITIES: ProviderCapabilities = { structuredOutput: true, resume: true };

export class ClaudeCodeAdapter implements ProviderAdapter {
  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly model: string | null;
  private readonly modelFamily: string | null;
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly cancellationGraceMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancellationRequests = new Set<string>();
  private version: string | null = null;

  constructor(config: ClaudeCodeAdapterConfig = {}) {
    this.executable = config.executable ?? "claude";
    this.baseArgs = config.baseArgs ?? [];
    this.model = config.model ?? null;
    this.modelFamily = config.modelFamily ?? inferClaudeModelFamily(this.model);
    this.startupTimeoutMs = config.startupTimeoutMs ?? 30_000;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 5 * 60_000;
    this.absoluteTimeoutMs = config.absoluteTimeoutMs ?? 30 * 60_000;
    this.cancellationGraceMs = config.cancellationGraceMs ?? 5_000;
    this.environment = config.environment ?? process.env;
  }

  async probe(): Promise<ProviderProbe> {
    const result = spawnSync(this.executable, [...this.baseArgs, "--version"], {
      encoding: "utf8",
      env: this.environment,
      windowsHide: true,
    });
    const available = result.status === 0 && result.error === undefined;
    this.version = available ? firstLine(result.stdout || result.stderr || "") : null;
    return {
      available,
      identity: this.identity(),
      capabilities: CAPABILITIES,
      error: available ? null : result.error?.message ?? result.stderr?.trim() ?? "probe failed",
    };
  }

  run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    return this.invoke(request, null);
  }

  resume(threadId: string, request: ProviderRunRequest): Promise<ProviderRunResult> {
    return this.invoke(request, threadId);
  }

  async cancel(invocationId: string): Promise<boolean> {
    const child = this.active.get(invocationId);
    if (!child) return false;
    const signalled = child.kill("SIGTERM");
    if (signalled) {
      this.cancellationRequests.add(invocationId);
      const timer = setTimeout(() => {
        if (this.active.get(invocationId) === child) child.kill("SIGKILL");
      }, this.cancellationGraceMs);
      timer.unref();
    }
    return signalled;
  }

  private identity(): ProviderIdentity {
    return {
      provider: "anthropic-claude-code",
      model: this.model,
      modelFamily: this.modelFamily,
      executable: this.executable,
      version: this.version,
    };
  }

  private async invoke(request: ProviderRunRequest, resumeSessionId: string | null): Promise<ProviderRunResult> {
    if (this.active.has(request.invocationId)) throw new Error(`Invocation is already active: ${request.invocationId}`);
    const artifactDirectory = resolve(request.artifactDirectory);
    mkdirSync(artifactDirectory, { recursive: true });
    const eventsPath = resolve(artifactDirectory, "response.json");
    const finalOutputPath = resolve(artifactDirectory, "final.json");
    const stderrPath = resolve(artifactDirectory, "stderr.log");
    const schema = readFileSync(resolve(request.outputSchemaPath), "utf8");
    const args = buildClaudeCodeArgs(this.baseArgs, this.model, schema, resumeSessionId);
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let sawActivity = false;

    const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done) => {
      const child = spawn(this.executable, args, {
        cwd: request.cwd,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.active.set(request.invocationId, child);
      child.stdin.on("error", (error) => { stderr += `${error.message}\n`; });
      child.stdin.end(request.prompt);
      let startupTimer: NodeJS.Timeout | null = setTimeout(() => timeout(), this.startupTimeoutMs);
      let idleTimer: NodeJS.Timeout | null = null;
      const absoluteTimer = setTimeout(() => timeout(), this.absoluteTimeoutMs);
      const activity = () => {
        sawActivity = true;
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = null;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => timeout(), this.idleTimeoutMs);
      };
      const timeout = () => {
        timedOut = true;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), this.cancellationGraceMs);
        timer.unref();
      };
      child.stdout.on("data", (chunk: Buffer) => { activity(); stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { activity(); stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { stderr += `${error.message}\n`; });
      child.once("close", (exitCode, signal) => {
        if (startupTimer) clearTimeout(startupTimer);
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(absoluteTimer);
        this.active.delete(request.invocationId);
        done({ exitCode, signal });
      });
    });

    const cancelled = !timedOut && this.cancellationRequests.delete(request.invocationId);
    writeFileSync(eventsPath, stdout);
    writeFileSync(stderrPath, stderr);
    let envelope: Record<string, unknown> | null = null;
    try { envelope = asRecord(JSON.parse(stdout)); } catch { /* classified below */ }
    const finalOutput = envelope ? extractFinalOutput(envelope) : null;
    if (finalOutput !== null) writeFileSync(finalOutputPath, JSON.stringify(finalOutput));
    const sessionId = envelope && typeof envelope.session_id === "string" ? envelope.session_id : null;
    const usage = envelope ? extractUsage(envelope.usage) : null;
    const providerError = envelope?.is_error === true;
    const valid = envelope !== null && finalOutput !== null && sessionId !== null;
    const ok = completion.exitCode === 0 && !timedOut && !cancelled && !providerError && valid;
    const failureClass: ProviderFailureClass | null = ok
      ? null
      : timedOut ? "timeout"
      : completion.exitCode === 0 && !providerError ? "invalid_output"
      : classifyProviderFailure(`${stderr}\n${stdout}`);
    return {
      invocationId: request.invocationId,
      ok,
      cancelled,
      identity: this.identity(),
      threadId: sessionId,
      events: envelope ? [envelope] : [],
      finalOutput,
      stderr,
      exitCode: completion.exitCode,
      signal: completion.signal,
      durationMs: Date.now() - started,
      usage,
      failureClass,
      eventsPath,
      finalOutputPath,
      stderrPath,
    };
  }
}

export function buildClaudeCodeArgs(
  baseArgs: readonly string[],
  model: string | null,
  schema: string,
  resumeSessionId: string | null,
): string[] {
  return [
    ...baseArgs,
    "--print",
    "--output-format", "json",
    "--json-schema", schema,
    ...(model ? ["--model", model] : []),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
  ];
}

export function inferClaudeModelFamily(model: string | null): string | null {
  if (!model) return null;
  const match = model.toLowerCase().match(/(?:^|-)claude-(opus|sonnet|haiku)(?:-|$)/u);
  if (match) return match[1] ?? null;
  return /^(opus|sonnet|haiku)$/u.test(model.toLowerCase()) ? model.toLowerCase() : null;
}

function extractFinalOutput(envelope: Record<string, unknown>): unknown | null {
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  if (typeof envelope.result !== "string") return null;
  try { return JSON.parse(envelope.result) as unknown; } catch { return null; }
}

function extractUsage(value: unknown): ProviderUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const inputTokens = numeric(usage.input_tokens);
  const cachedInputTokens = numeric(usage.cache_read_input_tokens);
  const outputTokens = numeric(usage.output_tokens);
  return inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined
    ? null : { inputTokens, cachedInputTokens, outputTokens };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function firstLine(value: string): string | null {
  return value.trim().split(/\r?\n/u)[0] || null;
}
