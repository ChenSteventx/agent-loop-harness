import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderAdapter, ProviderFailureClass, ProviderIdentity, ProviderProbe, ProviderRunRequest, ProviderRunResult, ProviderUsage, ProviderWorkspaceIsolation } from "./provider.js";
import { classifyProviderFailure } from "./provider.js";

export interface PiModelConfig { id: string; displayName?: string }
export interface PiRoutes { highCapability: PiModelConfig; fastAuxiliary: PiModelConfig }
export interface PiAdapterConfig {
  executable?: string;
  baseArgs?: readonly string[];
  provider: string;
  routes: PiRoutes;
  route: "highCapability" | "fastAuxiliary";
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  cancellationGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
}

interface PiProbeData { version?: string; rpc?: boolean; json?: boolean; models?: Array<{ id: string; displayName?: string }> }

export class PiAdapter implements ProviderAdapter {
  readonly workspaceIsolation: ProviderWorkspaceIsolation = {
    readOnly: "unverified",
    workspaceWrite: "unverified",
  };

  private readonly config: PiAdapterConfig;
  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancellations = new Set<string>();
  private version: string | null = null;
  private rpc = false;
  private probedModel: PiModelConfig | null = null;

  constructor(config: PiAdapterConfig) {
    this.config = config;
    this.executable = config.executable ?? "pi";
    this.baseArgs = config.baseArgs ?? [];
    this.environment = config.environment ?? process.env;
  }

  async probe(): Promise<ProviderProbe> {
    const versionResult = spawnSync(this.executable, [...this.baseArgs, "--version"], { encoding: "utf8", env: this.environment, windowsHide: true });
    if (versionResult.error || versionResult.status !== 0) {
      this.version = null;
      return { available: false, identity: this.identity(), capabilities: { structuredOutput: false, resume: false }, error: versionResult.error?.message ?? versionResult.stderr.trim() ?? "probe failed" };
    }
    this.version = firstLine(versionResult.stdout || versionResult.stderr);
    const probeResult = spawnSync(this.executable, [...this.baseArgs, "--probe-json"], { encoding: "utf8", env: this.environment, windowsHide: true });
    const data = probeResult.status === 0 ? parseProbe(probeResult.stdout) : null;
    if (data?.version) this.version = data.version;
    const helpResult = data ? null : spawnSync(this.executable, [...this.baseArgs, "--help"], { encoding: "utf8", env: this.environment, windowsHide: true });
    const help = `${helpResult?.stdout ?? ""}\n${helpResult?.stderr ?? ""}`;
    this.rpc = data?.rpc === true || /--mode(?:[= ]+)rpc|rpc mode/iu.test(help);
    const configured = this.config.routes[this.config.route];
    this.probedModel = data?.models?.find((model) => model.id === configured.id) ?? null;
    return { available: true, identity: this.identity(), capabilities: { structuredOutput: this.rpc || data?.json === true, resume: false }, error: null };
  }

  run(request: ProviderRunRequest): Promise<ProviderRunResult> { return this.invoke(request); }

  async cancel(invocationId: string): Promise<boolean> {
    const child = this.active.get(invocationId);
    if (!child) return false;
    const signalled = child.kill("SIGTERM");
    if (signalled) this.cancellations.add(invocationId);
    return signalled;
  }

  private identity(): ProviderIdentity {
    const model = this.probedModel ?? this.config.routes[this.config.route];
    return { provider: this.config.provider, model: model.id, modelDisplayName: model.displayName ?? null, executable: this.executable, version: this.version };
  }

  private async invoke(request: ProviderRunRequest): Promise<ProviderRunResult> {
    if (this.active.has(request.invocationId)) throw new Error(`Invocation is already active: ${request.invocationId}`);
    const artifactDirectory = resolve(request.artifactDirectory);
    mkdirSync(artifactDirectory, { recursive: true });
    const eventsPath = resolve(artifactDirectory, "events.jsonl");
    const finalOutputPath = resolve(artifactDirectory, "final.json");
    const stderrPath = resolve(artifactDirectory, "stderr.log");
    const schema = readFileSync(resolve(request.outputSchemaPath), "utf8");
    const model = this.config.routes[this.config.route].id;
    const args = [...this.baseArgs, ...(this.rpc ? ["--mode", "rpc"] : ["--json"]), "--provider", this.config.provider, "--model", model];
    const started = Date.now();
    let stderr = "";
    let eventText = "";
    const events: unknown[] = [];
    let finalOutput: unknown | null = null;
    let usage: ProviderUsage | null = null;
    let malformed = false;
    let timedOut = false;
    const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done) => {
      const child = spawn(this.executable, args, { cwd: request.cwd, env: this.environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.active.set(request.invocationId, child);
      child.stdin.on("error", (error) => { stderr += `${error.message}\n`; });
      child.stdin.end(this.rpc ? `${JSON.stringify({ type: "prompt", message: request.prompt, outputSchema: JSON.parse(schema) })}\n` : request.prompt);
      const timeout = () => { timedOut = true; child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), this.config.cancellationGraceMs ?? 5_000); timer.unref(); };
      let startup: NodeJS.Timeout | null = setTimeout(timeout, this.config.startupTimeoutMs ?? 30_000);
      let idle: NodeJS.Timeout | null = null;
      const absolute = setTimeout(timeout, this.config.absoluteTimeoutMs ?? 30 * 60_000);
      const activity = () => { if (startup) clearTimeout(startup); startup = null; if (idle) clearTimeout(idle); idle = setTimeout(timeout, this.config.idleTimeoutMs ?? 5 * 60_000); };
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        activity(); eventText += `${line}\n`;
        try {
          const event = JSON.parse(line) as Record<string, unknown>; events.push(event);
          if ((event.type === "result" || event.type === "done") && event.output !== undefined) finalOutput = event.output;
          if (event.usage && typeof event.usage === "object") usage = extractUsage(event.usage as Record<string, unknown>);
        } catch { malformed = true; }
      });
      child.stderr.on("data", (chunk: Buffer) => { activity(); stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { stderr += `${error.message}\n`; });
      child.once("close", (exitCode, signal) => { if (startup) clearTimeout(startup); if (idle) clearTimeout(idle); clearTimeout(absolute); this.active.delete(request.invocationId); done({ exitCode, signal }); });
    });
    const cancelled = !timedOut && this.cancellations.delete(request.invocationId);
    writeFileSync(eventsPath, eventText); writeFileSync(stderrPath, stderr);
    if (finalOutput !== null) writeFileSync(finalOutputPath, JSON.stringify(finalOutput));
    const ok = completion.exitCode === 0 && !timedOut && !cancelled && !malformed && finalOutput !== null;
    const failureClass: ProviderFailureClass | null = ok ? null : timedOut ? "timeout" : completion.exitCode === 0 && (malformed || finalOutput === null) ? "invalid_output" : classifyProviderFailure(`${stderr}\n${eventText}`);
    return { invocationId: request.invocationId, ok, cancelled, identity: this.identity(), threadId: null, events, finalOutput, stderr, exitCode: completion.exitCode, signal: completion.signal, durationMs: Date.now() - started, usage, failureClass, eventsPath, finalOutputPath, stderrPath };
  }
}

function parseProbe(text: string): PiProbeData | null { try { const value = JSON.parse(text) as unknown; return typeof value === "object" && value !== null ? value as PiProbeData : null; } catch { return null; } }
function firstLine(text: string): string | null { return text.trim().split(/\r?\n/u)[0] || null; }
function extractUsage(value: Record<string, unknown>): ProviderUsage | null {
  const inputTokens = number(value.inputTokens ?? value.input_tokens); const cachedInputTokens = number(value.cachedInputTokens ?? value.cached_input_tokens); const outputTokens = number(value.outputTokens ?? value.output_tokens);
  return inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined ? null : { inputTokens, cachedInputTokens, outputTokens };
}
function number(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
