import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface GitState {
  root: string;
  head: string;
  branch: string;
  dirty: boolean;
  diff: string;
  diffHash: string;
}

export class GitService {
  readonly root: string;

  constructor(directory: string) {
    this.root = this.git(["rev-parse", "--show-toplevel"], directory).trim();
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  branch(): string {
    return this.git(["branch", "--show-current"]).trim();
  }

  commonDirectory(): string {
    return resolve(this.root, this.git(["rev-parse", "--git-common-dir"]).trim());
  }

  isDirty(): boolean {
    return this.git(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  }

  diff(): string {
    const tracked = this.git(["diff", "--binary", "HEAD"]);
    const untracked = this.git(["ls-files", "--others", "--exclude-standard"])
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort()
      .map((path) => {
        const absolute = resolve(this.root, path);
        const content = existsSync(absolute) ? readFileSync(absolute) : Buffer.alloc(0);
        return `\nUNTRACKED ${path}\n${content.toString("base64")}\n`;
      })
      .join("");
    return tracked + untracked;
  }

  diffHash(): string {
    return createHash("sha256").update(this.diff()).digest("hex");
  }

  state(): GitState {
    const diff = this.diff();
    return {
      root: this.root,
      head: this.head(),
      branch: this.branch(),
      dirty: this.isDirty(),
      diff,
      diffHash: createHash("sha256").update(diff).digest("hex"),
    };
  }

  private git(args: readonly string[], cwd = this.root): string {
    try {
      return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${errorMessage(error)}`);
    }
  }
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
}

export class WorktreeService {
  readonly sourceRoot: string;

  constructor(sourceDirectory: string) {
    this.sourceRoot = new GitService(sourceDirectory).root;
  }

  create(path: string, branch: string, baseRef = "HEAD"): WorktreeInfo {
    this.assertIsolated(path);
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.git(["worktree", "add", "-b", branch, resolve(path), baseRef]);
    const git = new GitService(path);
    return { path: git.root, head: git.head(), branch: git.branch() || null };
  }

  list(): WorktreeInfo[] {
    const output = this.git(["worktree", "list", "--porcelain"]);
    const entries: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    for (const line of output.split(/\r?\n/u)) {
      if (!line) {
        if (current.path && current.head) entries.push({ path: current.path, head: current.head, branch: current.branch ?? null });
        current = {};
      } else if (line.startsWith("worktree ")) current.path = line.slice(9);
      else if (line.startsWith("HEAD ")) current.head = line.slice(5);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//u, "");
    }
    if (current.path && current.head) entries.push({ path: current.path, head: current.head, branch: current.branch ?? null });
    return entries;
  }

  remove(path: string, force = false): void {
    this.assertIsolated(path);
    this.git(["worktree", "remove", ...(force ? ["--force"] : []), resolve(path)]);
  }

  private assertIsolated(path: string): void {
    const source = normalizeExisting(this.sourceRoot);
    const candidate = normalizeExisting(resolve(path));
    if (source === candidate) throw new Error("Source checkout cannot be used as an isolated task worktree");
  }

  private git(args: readonly string[]): string {
    try {
      return execFileSync("git", [...args], {
        cwd: this.sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed: ${errorMessage(error)}`);
    }
  }
}

export interface CommandRequest {
  argv: [string, ...string[]];
  cwd: string;
  artifactDirectory: string;
  environmentAllowlist?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  shell?: boolean;
  terminationGraceMs?: number;
}

export interface CommandResult {
  argv: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  commitBefore: string;
}

export class CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.argv.length === 0 || !request.argv[0]) throw new Error("Command argv cannot be empty");
    const timeoutMs = positiveInteger(request.timeoutMs ?? 60_000, "timeoutMs");
    const limit = nonnegativeInteger(request.outputLimitBytes ?? 1024 * 1024, "outputLimitBytes");
    const terminationGraceMs = positiveInteger(request.terminationGraceMs ?? 1_000, "terminationGraceMs");
    const allowlist = new Set(request.environmentAllowlist ?? []);
    for (const name of Object.keys(request.environment ?? {})) {
      if (!allowlist.has(name)) throw new Error(`Environment variable is not allowlisted: ${name}`);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const name of allowlist) {
      if (request.environment?.[name] !== undefined) env[name] = request.environment[name];
      else if (process.env[name] !== undefined) env[name] = process.env[name];
    }

    const commitBefore = new GitService(request.cwd).head();
    const artifactDirectory = resolve(request.artifactDirectory);
    mkdirSync(artifactDirectory, { recursive: true });
    const stdoutPath = resolve(artifactDirectory, "stdout.log");
    const stderrPath = resolve(artifactDirectory, "stderr.log");
    const started = Date.now();
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolveCompletion, reject) => {
        const child = spawn(request.argv[0], request.argv.slice(1), {
          cwd: request.cwd,
          env,
          shell: request.shell ?? false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let forceKillTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
          forceKillTimer.unref();
        }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
          const captured = appendBounded(stdout, chunk, limit);
          stdout = captured.value;
          stdoutTruncated ||= captured.truncated;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const captured = appendBounded(stderr, chunk, limit);
          stderr = captured.value;
          stderrTruncated ||= captured.truncated;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          resolveCompletion({ exitCode, signal });
        });
      },
    );

    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);
    return {
      argv: request.argv,
      cwd: resolve(request.cwd),
      exitCode: completion.exitCode,
      signal: completion.signal,
      durationMs: Date.now() - started,
      timedOut,
      stdoutPath,
      stderrPath,
      stdoutTruncated,
      stderrTruncated,
      commitBefore,
    };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const remaining = limit - current.length;
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: chunk.length > remaining };
}

function normalizeExisting(path: string): string {
  const normalized = existsSync(path) ? realpathSync(path) : resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function safeBranchName(taskId: string, runId: string): string {
  const clean = `${taskId}-${runId}`.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `agent-loop/${clean || basename(runId)}`;
}
