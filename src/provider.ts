import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type ProviderFailureClass =
  | "transient"
  | "rate_limit"
  | "quota"
  | "auth"
  | "unavailable"
  | "timeout"
  | "invalid_output"
  | "unknown";

export interface ProviderIdentity {
  provider: string;
  model: string | null;
  modelDisplayName?: string | null;
  modelFamily?: string | null;
  executable: string;
  version: string | null;
}

export interface ProviderCapabilities {
  structuredOutput: boolean;
  resume: boolean;
}

export type ProviderWorkspaceIsolationLevel = "enforced" | "unverified";

export interface ProviderWorkspaceIsolation {
  readOnly: ProviderWorkspaceIsolationLevel;
  workspaceWrite: ProviderWorkspaceIsolationLevel;
}

export interface ProviderProbe {
  available: boolean;
  identity: ProviderIdentity;
  capabilities?: ProviderCapabilities;
  error: string | null;
}

export interface ProviderRunRequest {
  invocationId: string;
  prompt: string;
  cwd: string;
  artifactDirectory: string;
  outputSchemaPath: string;
  workspaceAccess?: "read-only" | "workspace-write";
  allowedRepositoryRoots?: readonly string[];
  contextBudget?: number;
  additionalWritableDirectories?: readonly string[];
  maximumPromptBytes?: number;
}

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface ProviderRunResult {
  invocationId: string;
  ok: boolean;
  cancelled: boolean;
  identity: ProviderIdentity;
  threadId: string | null;
  events: unknown[];
  finalOutput: unknown | null;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  usage: ProviderUsage | null;
  failureClass: ProviderFailureClass | null;
  eventsPath: string;
  finalOutputPath: string;
  stderrPath: string;
}

export interface ProviderAdapter {
  readonly workspaceIsolation?: ProviderWorkspaceIsolation;
  probe(): Promise<ProviderProbe>;
  run(request: ProviderRunRequest): Promise<ProviderRunResult>;
  resume?(threadId: string, request: ProviderRunRequest): Promise<ProviderRunResult>;
  cancel(invocationId: string): Promise<boolean>;
}

export interface CodexCliAdapterConfig {
  executable?: string;
  baseArgs?: readonly string[];
  provider?: string;
  model?: string | null;
  sandbox: "read-only" | "workspace-write";
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  cancellationGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface CodexLaunch {
  executable: string;
  baseArgs: string[];
}

export interface CodexLaunchOptions {
  explicitExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

export function resolveCodexLaunch(options: CodexLaunchOptions = {}): CodexLaunch {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const override = options.explicitExecutable ?? environment.CODEX_BIN;
  if (override) return launchForOverride(override, platform, nodeExecutable);
  if (platform !== "win32") return { executable: "codex", baseArgs: [] };

  const pathValue = environment.PATH ?? environment.Path ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { executable: nodeExecutable, baseArgs: [script] };
  }
  return { executable: "codex.exe", baseArgs: [] };
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly workspaceIsolation: ProviderWorkspaceIsolation = {
    readOnly: "enforced",
    workspaceWrite: "enforced",
  };

  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly provider: string;
  private readonly model: string | null;
  private readonly sandbox: CodexCliAdapterConfig["sandbox"];
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly cancellationGraceMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancellationRequests = new Set<string>();
  private readonly forcedCancellationTimers = new Map<string, NodeJS.Timeout>();
  private version: string | null = null;

  constructor(config: CodexCliAdapterConfig) {
    this.environment = config.environment ?? process.env;
    const launch = resolveCodexLaunch({
      explicitExecutable: config.executable,
      environment: this.environment,
    });
    this.executable = launch.executable;
    this.baseArgs = [...launch.baseArgs, ...(config.baseArgs ?? [])];
    this.provider = config.provider ?? "openai-codex";
    this.model = config.model ?? null;
    this.sandbox = config.sandbox;
    this.startupTimeoutMs = config.startupTimeoutMs ?? 30_000;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 5 * 60_000;
    this.absoluteTimeoutMs = config.absoluteTimeoutMs ?? 30 * 60_000;
    this.cancellationGraceMs = config.cancellationGraceMs ?? 5_000;
  }

  async probe(): Promise<ProviderProbe> {
    const result = spawnSync(this.executable, [...this.baseArgs, "--version"], {
      encoding: "utf8",
      env: this.environment,
      windowsHide: true,
    });
    const available = result.status === 0 && result.error === undefined;
    this.version = available ? (result.stdout || result.stderr || "").trim().split(/\r?\n/u)[0] || null : null;
    return {
      available,
      identity: this.identity(),
      error: available ? null : result.error?.message ?? result.stderr?.trim() ?? "probe failed",
    };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    // The Invocation Manifest needs the adapter version for replayability;
    // callers that never probed would otherwise record a permanently null
    // version and no run could ever grade manifest-complete.
    if (this.version === null) await this.probe();
    return this.invoke(request, null);
  }

  async resume(threadId: string, request: ProviderRunRequest): Promise<ProviderRunResult> {
    if (this.version === null) await this.probe();
    return this.invoke(request, threadId);
  }

  async cancel(invocationId: string): Promise<boolean> {
    const child = this.active.get(invocationId);
    if (!child) return false;
    const signalled = child.kill("SIGTERM");
    if (signalled) {
      this.cancellationRequests.add(invocationId);
      this.forcedCancellationTimers.set(invocationId, setTimeout(() => {
        if (this.active.get(invocationId) === child) child.kill("SIGKILL");
      }, this.cancellationGraceMs));
    }
    return signalled;
  }

  private identity(): ProviderIdentity {
    return {
      provider: this.provider,
      model: this.model,
      executable: this.executable,
      version: this.version,
    };
  }

  private async invoke(request: ProviderRunRequest, resumeThreadId: string | null): Promise<ProviderRunResult> {
    if (this.active.has(request.invocationId)) {
      throw new Error(`Invocation is already active: ${request.invocationId}`);
    }
    const artifactDirectory = resolve(request.artifactDirectory);
    mkdirSync(artifactDirectory, { recursive: true });
    const eventsPath = resolve(artifactDirectory, "events.jsonl");
    const finalOutputPath = resolve(artifactDirectory, "final.json");
    const stderrPath = resolve(artifactDirectory, "stderr.log");
    const args = [
      ...this.baseArgs,
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--sandbox",
      request.workspaceAccess ?? this.sandbox,
      ...(this.model ? ["--model", this.model] : []),
      ...additionalWritableDirectoryArgs(
        request.workspaceAccess === "read-only" ? undefined : request.additionalWritableDirectories,
      ),
      "-c",
      'approval_policy="never"',
      "-c",
      "features.hooks=false",
      ...windowsSandboxConfigArgs(process.platform, this.environment),
      "-C",
      resolve(request.cwd),
      "--output-schema",
      resolve(request.outputSchemaPath),
      "-o",
      finalOutputPath,
      ...(resumeThreadId ? ["resume", resumeThreadId, "-"] : ["-"]),
    ];
    const started = Date.now();
    let stderr = "";
    let eventText = "";
    const events: unknown[] = [];
    let malformedEvent = false;
    let threadId: string | null = null;
    let usage: ProviderUsage | null = null;
    let timedOut = false;
    let cancelled = false;

    const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolveCompletion) => {
        const child = spawn(this.executable, args, {
          cwd: request.cwd,
          env: this.environment,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        this.active.set(request.invocationId, child);
        child.stdin.on("error", (error) => {
          stderr += `${error.message}\n`;
        });
        child.stdin.end(request.prompt);
        let startupTimer: NodeJS.Timeout | null = setTimeout(() => {
          timedOut = true;
          terminateWithGrace(child, this.cancellationGraceMs);
        }, this.startupTimeoutMs);
        let idleTimer: NodeJS.Timeout | null = null;
        const noteActivity = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            terminateWithGrace(child, this.cancellationGraceMs);
          }, this.idleTimeoutMs);
        };
        const absoluteTimer = setTimeout(() => {
          timedOut = true;
          terminateWithGrace(child, this.cancellationGraceMs);
        }, this.absoluteTimeoutMs);
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          noteActivity();
          eventText += `${line}\n`;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            events.push(event);
            if (event.type === "thread.started" && typeof event.thread_id === "string") {
              threadId = event.thread_id;
              if (startupTimer) clearTimeout(startupTimer);
              startupTimer = null;
            }
            if (event.type === "turn.completed" && isRecord(event.usage)) {
              usage = {
                inputTokens: numberValue(event.usage.input_tokens),
                cachedInputTokens: numberValue(event.usage.cached_input_tokens),
                outputTokens: numberValue(event.usage.output_tokens),
              };
            }
          } catch {
            malformedEvent = true;
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          noteActivity();
          stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
          stderr += `${error.message}\n`;
        });
        child.once("close", (exitCode, signal) => {
          if (startupTimer) clearTimeout(startupTimer);
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(absoluteTimer);
          const forcedCancellationTimer = this.forcedCancellationTimers.get(request.invocationId);
          if (forcedCancellationTimer) clearTimeout(forcedCancellationTimer);
          this.forcedCancellationTimers.delete(request.invocationId);
          const cancellationRequested = this.cancellationRequests.delete(request.invocationId);
          cancelled = !timedOut && cancellationRequested;
          this.active.delete(request.invocationId);
          resolveCompletion({ exitCode, signal });
        });
      },
    );

    writeFileSync(eventsPath, eventText);
    writeFileSync(stderrPath, stderr);
    let finalOutput: unknown | null = null;
    let invalidFinal = false;
    try {
      finalOutput = JSON.parse(readFileSync(finalOutputPath, "utf8")) as unknown;
    } catch {
      invalidFinal = true;
    }
    const ok = completion.exitCode === 0 && !timedOut && !cancelled && !malformedEvent && !invalidFinal && threadId !== null;
    const failureClass = ok
      ? null
      : timedOut
        ? "timeout"
        : completion.exitCode === 0 && (malformedEvent || invalidFinal || threadId === null)
          ? "invalid_output"
          : classifyProviderFailure(stderr + "\n" + eventText);
    return {
      invocationId: request.invocationId,
      ok,
      cancelled,
      identity: this.identity(),
      threadId,
      events,
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

export function additionalWritableDirectoryArgs(
  directories: readonly string[] | undefined,
): string[] {
  return (directories ?? []).flatMap((directory) => ["--add-dir", resolve(directory)]);
}

export function windowsSandboxConfigArgs(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32") return [];
  const mode = environment.CODEX_WINDOWS_SANDBOX ?? "elevated";
  if (mode !== "elevated" && mode !== "unelevated") {
    throw new Error("CODEX_WINDOWS_SANDBOX must be elevated or unelevated");
  }
  return ["-c", `windows.sandbox="${mode}"`];
}

export function classifyProviderFailure(text: string): ProviderFailureClass {
  const value = text.toLowerCase();
  if (/quota|usage limit|insufficient (credit|balance)|hard limit/u.test(value)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/u.test(value)) return "rate_limit";
  if (/authentication|not logged in|unauthorized|forbidden|invalid api key|\b401\b|\b403\b/u.test(value)) return "auth";
  if (/temporar|overload|\b503\b|connection reset|network/u.test(value)) return "transient";
  if (/unavailable|not found|enoent/u.test(value)) return "unavailable";
  if (/timed? ?out|timeout/u.test(value)) return "timeout";
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function terminateWithGrace(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  timer.unref();
}

function launchForOverride(
  executable: string,
  platform: NodeJS.Platform,
  nodeExecutable: string,
): CodexLaunch {
  const extension = extname(executable).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { executable: nodeExecutable, baseArgs: [executable] };
  }
  if (platform === "win32" && extension === ".cmd") {
    const script = join(dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { executable: nodeExecutable, baseArgs: [script] };
  }
  return { executable, baseArgs: [] };
}

export {
  buildClaudeCodeArgs,
  ClaudeCodeAdapter,
  inferClaudeModelFamily,
  type ClaudeCodeAdapterConfig,
} from "./claude-provider.js";

export { PiAdapter, type PiAdapterConfig, type PiModelConfig, type PiRoutes } from "./pi-provider.js";
