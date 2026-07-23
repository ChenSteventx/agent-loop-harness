import { createHash } from "node:crypto";
import { BudgetExceededError, defaultRunBudget, type RunBudget } from "./budget.js";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

export interface CandidateCommit {
  baseCommit: string;
  commitSha: string;
  diffHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

export class GitService {
  readonly root: string;

  constructor(directory: string, private readonly budget: RunBudget = defaultRunBudget()) {
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

  workflowControlState(knownHead?: string): { dirty: boolean; controlStateHash: string } {
    const head = knownHead ?? this.head();
    const status = this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    const dirty = status.split(/\r?\n/u).some((line) => line.length > 0 && !line.startsWith("#"));
    return {
      dirty,
      controlStateHash: createHash("sha256").update(head).update("\0").update(status).digest("hex"),
    };
  }

  diff(): string {
    const tracked = this.git(["diff", "--binary", "HEAD"]);
    this.assertWithinBudget("maximumDiffBytes", Buffer.byteLength(tracked), "tracked diff");
    const paths = this.git(["ls-files", "--others", "--exclude-standard"])
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort();
    this.assertWithinBudget("maximumUntrackedFiles", paths.length, "untracked file count");
    // Sizes are checked before any content is read so an oversized workspace
    // fails closed instead of being loaded into memory and base64-amplified.
    // lstat (not stat) so a symlink to an unbounded target cannot masquerade
    // as a small file, and only regular files are snapshotted: a FIFO or
    // device would block or stream without limit in a synchronous read.
    let untrackedTotal = 0;
    for (const path of paths) {
      const absolute = resolve(this.root, path);
      const stats = existsSync(absolute) ? lstatSync(absolute) : null;
      if (stats && !stats.isFile()) {
        throw new BudgetExceededError("maximumUntrackedFileBytes", Number.MAX_SAFE_INTEGER,
          this.budget.maximumUntrackedFileBytes, `untracked special file (not a regular file) ${path}`);
      }
      const size = stats?.size ?? 0;
      this.assertWithinBudget("maximumUntrackedFileBytes", size, `untracked file ${path}`);
      untrackedTotal += size;
      this.assertWithinBudget("maximumUntrackedTotalBytes", untrackedTotal, "untracked files total");
    }
    let readTotal = 0;
    const untracked = paths
      .map((path) => {
        const absolute = resolve(this.root, path);
        const content = existsSync(absolute) ? readFileSync(absolute) : Buffer.alloc(0);
        // Re-checked after the read: a file can grow between stat and read.
        this.assertWithinBudget("maximumUntrackedFileBytes", content.length, `untracked file ${path}`);
        readTotal += content.length;
        this.assertWithinBudget("maximumUntrackedTotalBytes", readTotal, "untracked files total");
        return `\nUNTRACKED ${path}\n${content.toString("base64")}\n`;
      })
      .join("");
    return tracked + untracked;
  }

  private assertWithinBudget(
    boundary: "maximumDiffBytes" | "maximumUntrackedFiles" | "maximumUntrackedFileBytes" | "maximumUntrackedTotalBytes",
    observed: number,
    detail: string,
  ): void {
    const limit = this.budget[boundary];
    if (observed > limit) throw new BudgetExceededError(boundary, observed, limit, detail);
  }

  diffHash(): string {
    return createHash("sha256").update(this.diff()).digest("hex");
  }

  stagedDiff(): string {
    const staged = this.git(["diff", "--cached", "--binary", "HEAD"]);
    this.assertWithinBudget("maximumDiffBytes", Buffer.byteLength(staged), "staged diff");
    return staged;
  }

  hasStagedChanges(): boolean {
    return this.stagedDiff().length > 0;
  }

  diffBetween(baseCommit: string, commitSha = "HEAD"): string {
    const diff = this.git(["diff", "--binary", baseCommit, commitSha]);
    this.assertWithinBudget("maximumDiffBytes", Buffer.byteLength(diff), `diff ${baseCommit}..${commitSha}`);
    return diff;
  }

  diffHashBetween(baseCommit: string, commitSha = "HEAD"): string {
    return createHash("sha256").update(this.diffBetween(baseCommit, commitSha)).digest("hex");
  }

  changedFilesBetween(baseCommit: string, commitSha = "HEAD"): string[] {
    return this.git(["diff", "--name-only", "-z", baseCommit, commitSha])
      .split("\0")
      .filter(Boolean)
      .sort();
  }

  parent(commitSha = "HEAD"): string {
    return this.git(["rev-parse", `${commitSha}^`]).trim();
  }

  controlStateHash(knownHead?: string): string {
    const head = knownHead ?? this.head();
    const branch = this.branch();
    const index = this.git(["ls-files", "--stage", "-z"]);
    const headReflog = this.git(["reflog", "show", "HEAD", "--format=%H%x00%gD%x00%gs"]);
    return createHash("sha256")
      .update(head).update("\0")
      .update(branch).update("\0")
      .update(index).update("\0")
      .update(headReflog)
      .digest("hex");
  }

  commitCandidate(input: {
    baseCommit: string;
    message: string;
    authorName?: string;
    authorEmail?: string;
  }): CandidateCommit {
    if (this.head() !== input.baseCommit) {
      throw new Error("Candidate commit base does not match the current HEAD");
    }
    if (!this.isDirty()) throw new Error("Candidate commit requires a non-empty working diff");
    if (this.hasStagedChanges()) {
      throw new Error("Provider changed the Git index; only the Harness may stage candidate files");
    }
    const message = requiredText(input.message, "Candidate commit message");
    const authorName = requiredText(input.authorName ?? "Agent Loop Harness", "Candidate author name");
    const authorEmail = requiredText(input.authorEmail ?? "agent-loop@localhost", "Candidate author email");
    this.git(["add", "--all"]);
    const stagedDiff = this.stagedDiff();
    if (!stagedDiff) throw new Error("Candidate staging produced an empty diff");
    const stagedDiffHash = createHash("sha256").update(stagedDiff).digest("hex");
    this.git([
      "-c", `user.name=${authorName}`,
      "-c", `user.email=${authorEmail}`,
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "--no-gpg-sign", "-m", message,
    ]);
    const commitSha = this.head();
    if (this.parent(commitSha) !== input.baseCommit) {
      throw new Error("Harness candidate commit has an unexpected parent");
    }
    const committedDiffHash = this.diffHashBetween(input.baseCommit, commitSha);
    if (committedDiffHash !== stagedDiffHash) {
      throw new Error("Committed candidate diff does not match the staged Harness diff");
    }
    if (this.isDirty()) throw new Error("Harness candidate commit left a dirty worktree");
    return {
      baseCommit: input.baseCommit,
      commitSha,
      diffHash: committedDiffHash,
      message,
      authorName,
      authorEmail,
    };
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

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function safeBranchName(taskId: string, runId: string): string {
  const clean = `${taskId}-${runId}`.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `agent-loop/${clean || basename(runId)}`;
}
