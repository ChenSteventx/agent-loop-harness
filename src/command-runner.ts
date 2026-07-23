import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { operationInputHash } from "./bindings.js";

const immutableImagePattern = /^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?@sha256:[0-9a-f]{64}$/u;
const snapshotScopeVersion = "git-tree/v1" as const;
const receiptSchemaVersion = 2 as const;
const nullDependencyInputHash = null;
const containerReapTimeoutMs = 15_000;
const containerAbsenceConfirmationMs = 1_000;
const containerReapPollMs = 50;

export type ContainmentOutcome =
  | "exited"
  | "killed"
  | "unconfirmed"
  | "workspace-mutated"
  | "dependency-mutated";

export interface OciRuntimeConfiguration {
  engine: "docker" | "podman";
  executable: string;
  baseArgs?: readonly string[];
}

export interface CommandRunnerOptions {
  runtime?: OciRuntimeConfiguration;
  imageDigest?: string;
  gitExecutable?: string;
  controlEnvironment?: NodeJS.ProcessEnv;
  pidsLimit?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  containerUser?: string;
  temporarySpaceBytes?: number;
  snapshotFileLimit?: number;
  snapshotByteLimit?: number;
  artifactFileLimit?: number;
  artifactByteLimit?: number;
  dependencyRoot?: string;
}

export interface DependencyInput {
  path: string;
  contentHash: string;
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
  policyVersion?: string | null;
  configurationHash?: string | null;
  dependencyInput?: DependencyInput | null;
}

export interface CommandResult {
  schemaVersion: 2;
  argv: readonly string[];
  cwd: string;
  repositoryIdentity: string;
  sourceCommit: string;
  sourceTree: string;
  commandSpecHash: string;
  policyVersion: string | null;
  configurationHash: string | null;
  imageDigest: string;
  containmentSpecHash: string;
  dependencyInputHash: string | null;
  sandboxPolicyHash: string;
  startedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  containmentOutcome: ContainmentOutcome;
  stdoutPath: string;
  stderrPath: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutHash: string;
  stderrHash: string;
  artifactManifestHash: string;
  snapshotScopeVersion: typeof snapshotScopeVersion;
  snapshotHashBefore: string;
  snapshotHashAfter: string;
  commitBefore: string;
  formalCommitAfter: string;
  formalDirtyBefore: boolean;
  formalDirtyAfter: boolean;
  formalControlHashBefore: string;
  formalControlHashAfter: string;
}

export interface CommandRunnerConfigurationBinding {
  imageDigest: string;
  containmentSpecHash: string;
}

export interface CommandReceiptExpectation {
  repositoryIdentity: string;
  sourceCommit: string;
  sourceTree: string;
  argv: readonly string[];
  commandSpecHash: string;
  policyVersion: string | null;
  configurationHash: string | null;
  dependencyInputHash: string | null;
  imageDigest: string;
  containmentSpecHash: string;
  sandboxPolicyHash: string;
}

interface ResolvedRunnerConfiguration {
  runtime: OciRuntimeConfiguration;
  runtimeExecutableHash: string;
  gitExecutable: string;
  gitExecutableHash: string;
  imageDigest: string;
  controlEnvironment: NodeJS.ProcessEnv;
  pidsLimit: number;
  memoryLimit: string;
  cpuLimit: string;
  containerUser: string;
  temporarySpaceBytes: number;
  snapshotFileLimit: number;
  snapshotByteLimit: number;
  artifactFileLimit: number;
  artifactByteLimit: number;
  dependencyRoot: string | null;
}

interface GitCommandState {
  root: string;
  commonDirectory: string;
  repositoryIdentity: string;
  head: string;
  tree: string;
  dirty: boolean;
  controlHash: string;
}

interface DirectoryManifest {
  hash: string;
  fileCount: number;
  totalBytes: number;
}

interface PreparedCommand {
  configuration: ResolvedRunnerConfiguration;
  before: GitCommandState;
  containerEnvironment: Readonly<Record<string, string>>;
  dependency: { path: string; contentHash: string } | null;
  timeoutMs: number;
  outputLimitBytes: number;
  terminationGraceMs: number;
  runtimeVersion: string;
  containmentSpecHash: string;
  sandboxPolicyHash: string;
  commandSpecHash: string;
  expectation: CommandReceiptExpectation;
}

export class ContainmentUnavailableError extends Error {
  readonly code = "OciContainmentUnavailable";

  constructor(detail: string) {
    super(`OCI containment is not configured or available: ${detail}`);
    this.name = "ContainmentUnavailableError";
  }
}

export function isImmutableImageDigest(value: string): boolean {
  return immutableImagePattern.test(value);
}

export class CommandRunner {
  private readonly configuration: ResolvedRunnerConfiguration | null;
  private readonly configurationError: string | null;
  private runtimeVersion: string | null = null;
  private imagePolicyChecked = false;

  constructor(options: CommandRunnerOptions = {}) {
    const resolved = resolveConfiguration(options);
    this.configuration = resolved.configuration;
    this.configurationError = resolved.error;
  }

  configurationBinding(): CommandRunnerConfigurationBinding | null {
    if (!this.configuration) return null;
    return {
      imageDigest: this.configuration.imageDigest,
      containmentSpecHash: containmentSpecHash(this.configuration),
    };
  }

  receiptExpectation(request: CommandRequest): CommandReceiptExpectation {
    return this.prepareCommand(request).expectation;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const prepared = this.prepareCommand(request);
    const {
      configuration,
      before,
      containerEnvironment,
      dependency,
      timeoutMs,
      outputLimitBytes,
      terminationGraceMs,
      containmentSpecHash: staticContainmentSpecHash,
      sandboxPolicyHash,
      commandSpecHash,
    } = prepared;

    let artifactDirectory = normalizedProspectiveAbsolute(request.artifactDirectory);
    assertOutsideRepository(artifactDirectory, before.root, "artifactDirectory");
    assertOutsideRepository(artifactDirectory, before.commonDirectory, "artifactDirectory");
    assertMountSafePath(artifactDirectory, "artifactDirectory");
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    artifactDirectory = normalizedAbsolute(artifactDirectory);
    assertOutsideRepository(artifactDirectory, before.root, "artifactDirectory");
    assertOutsideRepository(artifactDirectory, before.commonDirectory, "artifactDirectory");
    chmodSync(artifactDirectory, 0o700);

    // The SUT can write only its randomly named child directory. Receipt
    // logs live in a sibling directory that is never mounted, so a symlink
    // created by the SUT cannot redirect a later host write outside the
    // requested artifact root.
    const invocationNonce = randomBytes(16).toString("hex");
    const containerArtifactDirectory = join(artifactDirectory, `sut-${invocationNonce}`);
    const receiptDirectory = join(artifactDirectory, `receipt-${invocationNonce}`);
    mkdirSync(receiptDirectory, { mode: 0o700 });
    chmodSync(receiptDirectory, 0o700);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-loop-command-"));
    const workspace = join(temporaryRoot, "workspace");
    const artifactQuarantine = join(temporaryRoot, "artifact-quarantine");
    mkdirSync(workspace, { recursive: true, mode: 0o755 });
    mkdirSync(artifactQuarantine, { mode: 0o700 });

    const stdoutPath = resolve(receiptDirectory, "stdout.log");
    const stderrPath = resolve(receiptDirectory, "stderr.log");
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let containmentOutcome: ContainmentOutcome = "unconfirmed";
    let preserveTemporaryRoot = false;
    const startedAt = new Date().toISOString();
    const started = Date.now();

    try {
      materializeCommit(
        before.root,
        before.head,
        workspace,
        configuration.snapshotFileLimit,
        configuration.snapshotByteLimit,
        configuration,
      );
      const snapshotBefore = hashDirectory(
        workspace,
        configuration.snapshotFileLimit,
        configuration.snapshotByteLimit,
      );
      let mountedDependency: { path: string; contentHash: string } | null = null;
      if (dependency) {
        const dependencySnapshot = join(temporaryRoot, "dependency");
        const dependencyManifest = snapshotDirectory(
          dependency.path,
          dependencySnapshot,
          configuration.snapshotFileLimit,
          configuration.snapshotByteLimit,
        );
        if (dependencyManifest.hash !== dependency.contentHash) {
          throw new Error("Dependency input changed while creating its private execution snapshot");
        }
        mountedDependency = { path: dependencySnapshot, contentHash: dependency.contentHash };
      }
      const containerName = `agent-loop-${process.pid}-${randomBytes(8).toString("hex")}`;
      const runtimeArgs = buildRuntimeArgs({
        configuration,
        containerName,
        workspace,
        dependency: mountedDependency,
        environment: containerEnvironment,
        argv: request.argv,
      });
      const runtimeEnvironment = configuration.controlEnvironment;
      const completion = await runContainedProcess({
        configuration,
        runtimeArgs,
        runtimeEnvironment,
        containerName,
        timeoutMs,
        terminationGraceMs,
        onStdout(chunk) {
          const captured = appendBounded(stdout, chunk, outputLimitBytes);
          stdout = captured.value;
          stdoutTruncated ||= captured.truncated;
        },
        onStderr(chunk) {
          const captured = appendBounded(stderr, chunk, outputLimitBytes);
          stderr = captured.value;
          stderrTruncated ||= captured.truncated;
        },
        onTimeout() { timedOut = true; },
      });
      containmentOutcome = completion.containmentOutcome;
      if (!timedOut && containmentOutcome === "exited") {
        let copied = false;
        let removed = false;
        try {
          copied = await copyContainerArtifacts(
            configuration,
            runtimeEnvironment,
            containerName,
            artifactQuarantine,
          );
          if (copied) {
            const quarantinedManifest = hashDirectory(
              artifactQuarantine,
              configuration.artifactFileLimit,
              configuration.artifactByteLimit,
            );
            const exportedManifest = snapshotDirectory(
              artifactQuarantine,
              containerArtifactDirectory,
              configuration.artifactFileLimit,
              configuration.artifactByteLimit,
            );
            if (exportedManifest.hash !== quarantinedManifest.hash) {
              throw new Error("Validated artifact export changed while copying to the receipt directory");
            }
          }
        } finally {
          removed = await removeExitedContainer(configuration, runtimeEnvironment, containerName);
        }
        containmentOutcome = copied && removed ? "exited" : "unconfirmed";
      }
      preserveTemporaryRoot = containmentOutcome === "unconfirmed";
      if (!existsSync(containerArtifactDirectory)) {
        mkdirSync(containerArtifactDirectory, { mode: 0o700 });
      }
      writeFileSync(stdoutPath, stdout, { mode: 0o600 });
      writeFileSync(stderrPath, stderr, { mode: 0o600 });

      const snapshotAfter = hashDirectory(
        workspace,
        configuration.snapshotFileLimit,
        configuration.snapshotByteLimit,
      );
      if (!timedOut && containmentOutcome === "exited" && snapshotAfter.hash !== snapshotBefore.hash) {
        containmentOutcome = "workspace-mutated";
      }
      if (
        !timedOut &&
        containmentOutcome === "exited" &&
        mountedDependency &&
        hashDirectory(
          mountedDependency.path,
          configuration.snapshotFileLimit,
          configuration.snapshotByteLimit,
        ).hash !== mountedDependency.contentHash
      ) {
        containmentOutcome = "dependency-mutated";
      }
      const after = gitCommandState(request.cwd, configuration);
      const artifactManifest = hashDirectory(
        containerArtifactDirectory,
        configuration.artifactFileLimit,
        configuration.artifactByteLimit,
      );
      return {
        schemaVersion: receiptSchemaVersion,
        argv: [...request.argv],
        cwd: normalizedAbsolute(request.cwd),
        repositoryIdentity: before.repositoryIdentity,
        sourceCommit: before.head,
        sourceTree: before.tree,
        commandSpecHash,
        policyVersion: request.policyVersion ?? null,
        configurationHash: request.configurationHash ?? null,
        imageDigest: configuration.imageDigest,
        containmentSpecHash: staticContainmentSpecHash,
        dependencyInputHash: dependency?.contentHash ?? nullDependencyInputHash,
        sandboxPolicyHash,
        startedAt,
        exitCode: completion.exitCode,
        signal: completion.signal,
        durationMs: Date.now() - started,
        timedOut,
        containmentOutcome,
        stdoutPath,
        stderrPath,
        stdoutTruncated,
        stderrTruncated,
        stdoutHash: sha256(stdout),
        stderrHash: sha256(stderr),
        artifactManifestHash: artifactManifest.hash,
        snapshotScopeVersion,
        snapshotHashBefore: snapshotBefore.hash,
        snapshotHashAfter: snapshotAfter.hash,
        commitBefore: before.head,
        formalCommitAfter: after.head,
        formalDirtyBefore: before.dirty,
        formalDirtyAfter: after.dirty,
        formalControlHashBefore: before.controlHash,
        formalControlHashAfter: after.controlHash,
      };
    } finally {
      if (!preserveTemporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  private prepareCommand(request: CommandRequest): PreparedCommand {
    const configuration = this.requireConfiguration();
    validateRequest(request);
    const timeoutMs = positiveInteger(request.timeoutMs ?? 60_000, "timeoutMs");
    const outputLimitBytes = nonnegativeInteger(request.outputLimitBytes ?? 1024 * 1024, "outputLimitBytes");
    const terminationGraceMs = positiveInteger(request.terminationGraceMs ?? 1_000, "terminationGraceMs");
    const containerEnvironment = validateEnvironment(request);
    const before = gitCommandState(request.cwd, configuration);
    if (before.dirty) throw new Error("Formal command execution requires a clean repository worktree");
    if (normalizedAbsolute(request.cwd) !== before.root) {
      throw new Error("Formal command cwd must be the repository worktree root");
    }
    const dependency = validateDependencyInput(
      request.dependencyInput ?? null,
      configuration,
      before.root,
      before.commonDirectory,
    );
    const runtimeVersion = this.probeRuntime(configuration);
    this.assertImagePolicy(configuration);
    const staticContainmentSpecHash = containmentSpecHash(configuration);
    const sandboxPolicyHash = operationInputHash(sandboxPolicy(
      configuration,
      runtimeVersion,
      dependency?.contentHash ?? null,
      containerEnvironment,
      { timeoutMs, outputLimitBytes, terminationGraceMs },
    ));
    const commandSpecHash = commandSpecificationHash({
      request,
      before,
      configuration,
      dependencyInputHash: dependency?.contentHash ?? nullDependencyInputHash,
      containmentSpecHash: staticContainmentSpecHash,
      sandboxPolicyHash,
      containerEnvironment,
      executionLimits: { timeoutMs, outputLimitBytes, terminationGraceMs },
    });
    const expectation: CommandReceiptExpectation = {
      repositoryIdentity: before.repositoryIdentity,
      sourceCommit: before.head,
      sourceTree: before.tree,
      argv: [...request.argv],
      commandSpecHash,
      policyVersion: request.policyVersion ?? null,
      configurationHash: request.configurationHash ?? null,
      dependencyInputHash: dependency?.contentHash ?? nullDependencyInputHash,
      imageDigest: configuration.imageDigest,
      containmentSpecHash: staticContainmentSpecHash,
      sandboxPolicyHash,
    };
    return {
      configuration,
      before,
      containerEnvironment,
      dependency,
      timeoutMs,
      outputLimitBytes,
      terminationGraceMs,
      runtimeVersion,
      containmentSpecHash: staticContainmentSpecHash,
      sandboxPolicyHash,
      commandSpecHash,
      expectation,
    };
  }

  private requireConfiguration(): ResolvedRunnerConfiguration {
    if (!this.configuration) throw new ContainmentUnavailableError(this.configurationError ?? "unknown configuration error");
    return this.configuration;
  }

  private probeRuntime(configuration: ResolvedRunnerConfiguration): string {
    assertRuntimeExecutableIdentity(configuration);
    if (this.runtimeVersion) return this.runtimeVersion;
    try {
      const output = execFileSync(
        configuration.runtime.executable,
        [...(configuration.runtime.baseArgs ?? []), "version"],
        {
          env: configuration.controlEnvironment,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim();
      if (!output) throw new Error("empty version output");
      this.assertLocalRuntimeEndpoint(configuration);
      this.runtimeVersion = output.split(/\r?\n/u)[0]!.slice(0, 256);
      return this.runtimeVersion;
    } catch (error) {
      throw new ContainmentUnavailableError(
        `${configuration.runtime.engine} runtime probe failed: ${errorMessage(error)}`,
      );
    }
  }

  private assertLocalRuntimeEndpoint(configuration: ResolvedRunnerConfiguration): void {
    if (configuration.runtime.engine !== "docker" || configuration.controlEnvironment.DOCKER_HOST) return;
    assertRuntimeExecutableIdentity(configuration);
    try {
      const output = execFileSync(
        configuration.runtime.executable,
        [
          ...(configuration.runtime.baseArgs ?? []),
          "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}", "default",
        ],
        {
          env: configuration.controlEnvironment,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim();
      const endpoint = JSON.parse(output) as unknown;
      if (typeof endpoint !== "string" || !isLocalRuntimeEndpoint(endpoint)) {
        throw new Error(`default Docker context is not local: ${String(endpoint)}`);
      }
    } catch (error) {
      throw new ContainmentUnavailableError(`local Docker endpoint verification failed: ${errorMessage(error)}`);
    }
  }

  private assertImagePolicy(configuration: ResolvedRunnerConfiguration): void {
    assertRuntimeExecutableIdentity(configuration);
    if (this.imagePolicyChecked) return;
    try {
      const output = execFileSync(
        configuration.runtime.executable,
        [
          ...(configuration.runtime.baseArgs ?? []),
          "image", "inspect", "--format", "{{json .Config.Volumes}}", configuration.imageDigest,
        ],
        {
          env: configuration.controlEnvironment,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim();
      if (!output) throw new Error("empty image inspection output");
      const volumes = JSON.parse(output) as unknown;
      if (volumes !== null && (!isRecord(volumes) || Object.keys(volumes).length > 0)) {
        throw new Error("verification image declares writable volumes");
      }
      this.imagePolicyChecked = true;
    } catch (error) {
      throw new ContainmentUnavailableError(`immutable image inspection failed: ${errorMessage(error)}`);
    }
  }
}

export function commandReceiptMatchesExecution(
  value: unknown,
  expectation: CommandReceiptExpectation,
): value is CommandResult {
  if (!isRecord(value)) return false;
  const hashes = [
    value.repositoryIdentity,
    value.commandSpecHash,
    value.containmentSpecHash,
    value.sandboxPolicyHash,
    value.stdoutHash,
    value.stderrHash,
    value.artifactManifestHash,
    value.snapshotHashBefore,
    value.snapshotHashAfter,
    value.formalControlHashBefore,
    value.formalControlHashAfter,
  ];
  return value.schemaVersion === receiptSchemaVersion &&
    sameStringArray(value.argv, expectation.argv) &&
    typeof value.cwd === "string" &&
    hashes.every(isSha256) &&
    value.repositoryIdentity === expectation.repositoryIdentity &&
    isGitObjectId(value.sourceCommit) &&
    value.sourceCommit === expectation.sourceCommit &&
    value.commitBefore === expectation.sourceCommit &&
    value.formalCommitAfter === expectation.sourceCommit &&
    isGitObjectId(value.sourceTree) &&
    value.sourceTree === expectation.sourceTree &&
    value.commandSpecHash === expectation.commandSpecHash &&
    value.policyVersion === expectation.policyVersion &&
    value.configurationHash === expectation.configurationHash &&
    typeof value.imageDigest === "string" &&
    immutableImagePattern.test(value.imageDigest) &&
    value.imageDigest === expectation.imageDigest &&
    value.containmentSpecHash === expectation.containmentSpecHash &&
    value.sandboxPolicyHash === expectation.sandboxPolicyHash &&
    value.dependencyInputHash === expectation.dependencyInputHash &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    Number.isSafeInteger(value.durationMs) &&
    (value.durationMs as number) >= 0 &&
    Number.isSafeInteger(value.exitCode) &&
    (value.exitCode as number) >= 0 &&
    value.signal === null &&
    value.timedOut === false &&
    value.containmentOutcome === "exited" &&
    typeof value.stdoutPath === "string" &&
    typeof value.stderrPath === "string" &&
    typeof value.stdoutTruncated === "boolean" &&
    typeof value.stderrTruncated === "boolean" &&
    value.snapshotScopeVersion === snapshotScopeVersion &&
    value.snapshotHashBefore === value.snapshotHashAfter &&
    value.formalDirtyBefore === false &&
    value.formalDirtyAfter === false &&
    value.formalControlHashBefore === value.formalControlHashAfter;
}

export function commandReceiptProvesSuccess(
  value: unknown,
  expectation: CommandReceiptExpectation,
): value is CommandResult {
  return commandReceiptMatchesExecution(value, expectation) && value.exitCode === 0;
}

// Stable authority projection for identities that describe the logical proof.
// Host paths, wall-clock timestamps, and elapsed time remain diagnostics on
// the receipt but cannot make the same proof artifact hash differently.
export function commandReceiptProofProjection(value: CommandResult): unknown {
  return {
    schemaVersion: value.schemaVersion,
    argv: [...value.argv],
    repositoryIdentity: value.repositoryIdentity,
    sourceCommit: value.sourceCommit,
    sourceTree: value.sourceTree,
    commandSpecHash: value.commandSpecHash,
    policyVersion: value.policyVersion,
    configurationHash: value.configurationHash,
    imageDigest: value.imageDigest,
    containmentSpecHash: value.containmentSpecHash,
    dependencyInputHash: value.dependencyInputHash,
    sandboxPolicyHash: value.sandboxPolicyHash,
    exitCode: value.exitCode,
    signal: value.signal,
    timedOut: value.timedOut,
    containmentOutcome: value.containmentOutcome,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    stdoutHash: value.stdoutHash,
    stderrHash: value.stderrHash,
    artifactManifestHash: value.artifactManifestHash,
    snapshotScopeVersion: value.snapshotScopeVersion,
    snapshotHashBefore: value.snapshotHashBefore,
    snapshotHashAfter: value.snapshotHashAfter,
    commitBefore: value.commitBefore,
    formalCommitAfter: value.formalCommitAfter,
    formalDirtyBefore: value.formalDirtyBefore,
    formalDirtyAfter: value.formalDirtyAfter,
    formalControlHashBefore: value.formalControlHashBefore,
    formalControlHashAfter: value.formalControlHashAfter,
  };
}

function resolveConfiguration(options: CommandRunnerOptions): {
  configuration: ResolvedRunnerConfiguration | null;
  error: string | null;
} {
  const environment = options.controlEnvironment ?? process.env;
  let runtime = options.runtime;
  if (!runtime) {
    const engine = environment.AGENT_LOOP_OCI_ENGINE;
    const executable = environment.AGENT_LOOP_OCI_EXECUTABLE;
    if (engine === "docker" || engine === "podman") {
      let baseArgs: readonly string[] = [];
      if (environment.AGENT_LOOP_OCI_BASE_ARGS_JSON) {
        try {
          const parsed = JSON.parse(environment.AGENT_LOOP_OCI_BASE_ARGS_JSON) as unknown;
          if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value)) {
            return { configuration: null, error: "AGENT_LOOP_OCI_BASE_ARGS_JSON must be a JSON string array" };
          }
          baseArgs = parsed;
        } catch (error) {
          return { configuration: null, error: `invalid AGENT_LOOP_OCI_BASE_ARGS_JSON: ${errorMessage(error)}` };
        }
      }
      runtime = { engine, executable: executable?.trim() || engine, baseArgs };
    }
  }
  if (!runtime) return { configuration: null, error: "runtime engine is missing" };
  if (!runtime.executable.trim()) return { configuration: null, error: "runtime executable is empty" };
  if (runtime.baseArgs?.some((value) => !value)) return { configuration: null, error: "runtime base arguments cannot be empty" };

  const imageDigest = options.imageDigest ?? environment.AGENT_LOOP_OCI_IMAGE;
  if (!imageDigest) return { configuration: null, error: "immutable image digest is missing" };
  if (!immutableImagePattern.test(imageDigest)) {
    return { configuration: null, error: "image must be a repository reference pinned by @sha256:<64 lowercase hex>" };
  }

  try {
    const controlEnvironment = validatedRuntimeControlEnvironment(runtime, environment);
    runtime = {
      ...runtime,
      executable: resolveExecutable(runtime.executable, environment, "runtime"),
      baseArgs: runtime.engine === "podman"
        ? [...(runtime.baseArgs ?? []), "--remote=false"]
        : [...(runtime.baseArgs ?? [])],
    };
    const gitExecutable = resolveExecutable(
      options.gitExecutable ?? environment.AGENT_LOOP_GIT_EXECUTABLE ?? "git",
      environment,
      "Git",
    );
    return {
      configuration: {
        runtime,
        runtimeExecutableHash: sha256(readFileSync(runtime.executable)),
        gitExecutable,
        gitExecutableHash: sha256(readFileSync(gitExecutable)),
        imageDigest,
        controlEnvironment,
        pidsLimit: positiveInteger(options.pidsLimit ?? 256, "pidsLimit"),
        memoryLimit: boundedText(options.memoryLimit ?? "512m", "memoryLimit"),
        cpuLimit: boundedText(options.cpuLimit ?? "1", "cpuLimit"),
        containerUser: boundedText(options.containerUser ?? "65532:65532", "containerUser"),
        temporarySpaceBytes: positiveInteger(options.temporarySpaceBytes ?? 64 * 1024 * 1024, "temporarySpaceBytes"),
        snapshotFileLimit: positiveInteger(options.snapshotFileLimit ?? 100_000, "snapshotFileLimit"),
        snapshotByteLimit: positiveInteger(options.snapshotByteLimit ?? 1024 * 1024 * 1024, "snapshotByteLimit"),
        artifactFileLimit: positiveInteger(options.artifactFileLimit ?? 1_000, "artifactFileLimit"),
        artifactByteLimit: positiveInteger(options.artifactByteLimit ?? 64 * 1024 * 1024, "artifactByteLimit"),
        dependencyRoot: resolveDependencyRoot(options.dependencyRoot ?? environment.AGENT_LOOP_OCI_DEPENDENCY_ROOT),
      },
      error: null,
    };
  } catch (error) {
    return { configuration: null, error: errorMessage(error) };
  }
}

function validatedRuntimeControlEnvironment(
  runtime: OciRuntimeConfiguration,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const forbiddenRuntimeArguments = new Set([
    "--context", "--connection", "--host", "-H", "--remote", "--url",
  ]);
  if ((runtime.baseArgs ?? []).some((value) =>
    forbiddenRuntimeArguments.has(value) ||
    [...forbiddenRuntimeArguments].some((prefix) => value.startsWith(`${prefix}=`)) ||
    (value.startsWith("-H") && !value.startsWith("--")))) {
    throw new Error("runtime base arguments cannot select a remote endpoint");
  }
  const result = { ...environment };
  if (runtime.engine === "docker") {
    if (result.DOCKER_CONTEXT && result.DOCKER_CONTEXT !== "default") {
      throw new Error("DOCKER_CONTEXT must be unset or default for formal containment");
    }
    if (result.DOCKER_HOST && !isLocalRuntimeEndpoint(result.DOCKER_HOST)) {
      throw new Error("DOCKER_HOST must identify a local unix or named-pipe endpoint");
    }
    if (result.DOCKER_TLS_VERIFY || result.DOCKER_CERT_PATH) {
      throw new Error("Docker TLS endpoint configuration is not supported for formal containment");
    }
    if (result.DOCKER_HOST) delete result.DOCKER_CONTEXT;
    else result.DOCKER_CONTEXT = "default";
  } else {
    if (result.CONTAINER_CONNECTION) {
      throw new Error("CONTAINER_CONNECTION is not supported for formal containment");
    }
    if (result.CONTAINER_HOST) {
      throw new Error("CONTAINER_HOST is not supported; formal Podman execution forces local mode");
    }
  }
  return result;
}

function isLocalRuntimeEndpoint(value: string): boolean {
  return /^unix:\/\/\/[A-Za-z0-9_./-]+$/u.test(value) ||
    /^npipe:\/\/\/.+$/u.test(value);
}

function resolveExecutable(executable: string, environment: NodeJS.ProcessEnv, label: string): string {
  let resolvedExecutable: string;
  if (isAbsolute(executable)) {
    resolvedExecutable = normalizedAbsolute(executable);
  } else {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const located = execFileSync(locator, [executable], {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    }).split(/\r?\n/u).find(Boolean);
    if (!located) throw new Error(`${label} executable is not on PATH: ${executable}`);
    resolvedExecutable = normalizedAbsolute(located);
  }
  if (!existsSync(resolvedExecutable) || !statSync(resolvedExecutable).isFile()) {
    throw new Error(`${label} executable is not a file: ${resolvedExecutable}`);
  }
  accessSync(resolvedExecutable, constants.X_OK);
  return resolvedExecutable;
}

function resolveDependencyRoot(value: string | undefined): string | null {
  if (!value) return null;
  const root = normalizedAbsolute(value);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error("dependencyRoot must be an existing directory");
  }
  if (dirname(root) === root) throw new Error("dependencyRoot cannot be a filesystem root");
  assertMountSafePath(root, "dependencyRoot");
  return root;
}

function containmentSpecHash(configuration: ResolvedRunnerConfiguration): string {
  const endpointVariables = [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
  ];
  return operationInputHash({
    version: 1,
    git: {
      executablePathHash: sha256(configuration.gitExecutable),
      executableContentHash: configuration.gitExecutableHash,
      replaceObjects: "disabled",
      fsmonitor: "disabled",
      inheritedGitEnvironment: "stripped",
      systemAndGlobalConfig: "disabled",
    },
    runtime: {
      engine: configuration.runtime.engine,
      executablePathHash: sha256(configuration.runtime.executable),
      executableContentHash: configuration.runtimeExecutableHash,
      baseArgsHash: operationInputHash([...(configuration.runtime.baseArgs ?? [])]),
      endpoints: endpointVariables.map((name) => ({
        name,
        valueHash: configuration.controlEnvironment[name]
          ? sha256(configuration.controlEnvironment[name]!)
          : null,
      })),
    },
    imageDigest: configuration.imageDigest,
    network: "none",
    ipc: configuration.runtime.engine === "podman" ? "private" : "none",
    capabilities: [],
    noNewPrivileges: true,
    readOnlyRoot: true,
    init: true,
    healthcheck: "disabled",
    imageDeclaredVolumes: "rejected",
    podmanReadOnlyTmpfs: configuration.runtime.engine === "podman" ? false : null,
    podmanImageVolumes: configuration.runtime.engine === "podman" ? "ignore" : null,
    entrypoint: "command-argv-0",
    user: configuration.containerUser,
    limits: {
      pids: configuration.pidsLimit,
      memory: configuration.memoryLimit,
      memorySwap: configuration.memoryLimit,
      cpus: configuration.cpuLimit,
      temporarySpaceBytes: configuration.temporarySpaceBytes,
      snapshotFiles: configuration.snapshotFileLimit,
      snapshotBytes: configuration.snapshotByteLimit,
      artifactFiles: configuration.artifactFileLimit,
      artifactBytes: configuration.artifactByteLimit,
    },
    terminationConfirmation: {
      wholeContainer: true,
      reapTimeoutMs: containerReapTimeoutMs,
      absenceConfirmationMs: containerAbsenceConfirmationMs,
    },
    mounts: {
      workspace: { destination: "/workspace", readOnly: true, scope: snapshotScopeVersion },
      artifacts: {
        destination: "/artifacts",
        type: "tmpfs",
        readOnly: false,
        byteLimit: configuration.artifactByteLimit,
        inodeLimit: configuration.runtime.engine === "podman" ? null : configuration.artifactFileLimit,
        validatedFileLimit: configuration.artifactFileLimit,
        memoryCgroupBound: configuration.runtime.engine === "podman",
        mode: "1777",
        export: "validated-after-exit",
      },
      dependencies: { destination: "/dependencies", readOnly: true, optional: true },
      temporary: { destination: "/tmp", type: "tmpfs" },
    },
    dependencyRootIdentity: configuration.dependencyRoot ? sha256(configuration.dependencyRoot) : null,
  });
}

function validateRequest(request: CommandRequest): void {
  if (request.argv.length === 0 || !request.argv[0]) throw new Error("Command argv cannot be empty");
  if (request.shell) throw new Error("Contained formal commands do not support shell mode");
  positiveInteger(request.timeoutMs ?? 60_000, "timeoutMs");
  nonnegativeInteger(request.outputLimitBytes ?? 1024 * 1024, "outputLimitBytes");
  positiveInteger(request.terminationGraceMs ?? 1_000, "terminationGraceMs");
}

function validateEnvironment(request: CommandRequest): Record<string, string> {
  const allowlist = new Set(request.environmentAllowlist ?? []);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.environment ?? {})) {
    if (!allowlist.has(name)) throw new Error(`Environment variable is not allowlisted: ${name}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
    if (value.includes("\0")) throw new Error(`Environment variable contains NUL: ${name}`);
    result[name] = value;
  }
  return result;
}

function validateDependencyInput(
  input: DependencyInput | null,
  configuration: ResolvedRunnerConfiguration,
  repositoryRoot: string,
  gitCommonDirectory: string,
): { path: string; contentHash: string } | null {
  if (!input) return null;
  if (!configuration.dependencyRoot) {
    throw new Error("dependencyInput requires a configured content-addressed dependency root");
  }
  const path = normalizedAbsolute(input.path);
  assertOutsideRepository(path, repositoryRoot, "dependencyInput.path");
  assertOutsideRepository(path, gitCommonDirectory, "dependencyInput.path");
  assertMountSafePath(path, "dependencyInput.path");
  assertWithinDirectory(path, configuration.dependencyRoot, "dependencyInput.path");
  if (path === configuration.dependencyRoot) {
    throw new Error("dependencyInput.path must be a content-addressed child of dependencyRoot");
  }
  if (!statSync(path).isDirectory()) throw new Error("dependencyInput.path must be a directory");
  if (!/^[0-9a-f]{64}$/u.test(input.contentHash)) throw new Error("dependencyInput.contentHash must be sha256 hex");
  if (basename(path) !== input.contentHash) {
    throw new Error("dependencyInput.path must be named by its sha256 content hash");
  }
  const observed = hashDirectory(path, configuration.snapshotFileLimit, configuration.snapshotByteLimit).hash;
  if (observed !== input.contentHash) throw new Error("dependencyInput content hash does not match the mounted directory");
  return { path, contentHash: observed };
}

function sandboxPolicy(
  configuration: ResolvedRunnerConfiguration,
  runtimeVersion: string,
  dependencyInputHash: string | null,
  environment: Readonly<Record<string, string>>,
  executionLimits: { timeoutMs: number; outputLimitBytes: number; terminationGraceMs: number },
): unknown {
  return {
    version: 1,
    runtime: { engine: configuration.runtime.engine, version: runtimeVersion },
    imageDigest: configuration.imageDigest,
    network: "none",
    ipc: configuration.runtime.engine === "podman" ? "private" : "none",
    capabilities: [],
    noNewPrivileges: true,
    readOnlyRoot: true,
    healthcheck: "disabled",
    imageDeclaredVolumes: "rejected",
    podmanReadOnlyTmpfs: configuration.runtime.engine === "podman" ? false : null,
    podmanImageVolumes: configuration.runtime.engine === "podman" ? "ignore" : null,
    entrypoint: "command-argv-0",
    user: configuration.containerUser,
    limits: {
      pids: configuration.pidsLimit,
      memory: configuration.memoryLimit,
      memorySwap: configuration.memoryLimit,
      cpus: configuration.cpuLimit,
      temporarySpaceBytes: configuration.temporarySpaceBytes,
      snapshotFiles: configuration.snapshotFileLimit,
      snapshotBytes: configuration.snapshotByteLimit,
      artifactFiles: configuration.artifactFileLimit,
      artifactBytes: configuration.artifactByteLimit,
      commandTimeoutMs: executionLimits.timeoutMs,
      outputBytes: executionLimits.outputLimitBytes,
      terminationGraceMs: executionLimits.terminationGraceMs,
    },
    terminationConfirmation: {
      wholeContainer: true,
      reapTimeoutMs: containerReapTimeoutMs,
      absenceConfirmationMs: containerAbsenceConfirmationMs,
    },
    mounts: {
      workspace: { destination: "/workspace", readOnly: true, scope: snapshotScopeVersion },
      artifacts: {
        destination: "/artifacts",
        type: "tmpfs",
        readOnly: false,
        byteLimit: configuration.artifactByteLimit,
        inodeLimit: configuration.runtime.engine === "podman" ? null : configuration.artifactFileLimit,
        validatedFileLimit: configuration.artifactFileLimit,
        memoryCgroupBound: configuration.runtime.engine === "podman",
        mode: "1777",
        export: "validated-after-exit",
      },
      dependencies: dependencyInputHash
        ? { destination: "/dependencies", readOnly: true, contentHash: dependencyInputHash }
        : null,
      temporary: { destination: "/tmp", type: "tmpfs" },
    },
    environmentNames: Object.keys(environment).sort(),
  };
}

function commandSpecificationHash(input: {
  request: CommandRequest;
  before: GitCommandState;
  configuration: ResolvedRunnerConfiguration;
  dependencyInputHash: string | null;
  containmentSpecHash: string;
  sandboxPolicyHash: string;
  containerEnvironment: Readonly<Record<string, string>>;
  executionLimits: { timeoutMs: number; outputLimitBytes: number; terminationGraceMs: number };
}): string {
  return operationInputHash({
    version: 2,
    argv: [...input.request.argv],
    repositoryIdentity: input.before.repositoryIdentity,
    sourceCommit: input.before.head,
    sourceTree: input.before.tree,
    policyVersion: input.request.policyVersion ?? null,
    configurationHash: input.request.configurationHash ?? null,
    imageDigest: input.configuration.imageDigest,
    containmentSpecHash: input.containmentSpecHash,
    dependencyInputHash: input.dependencyInputHash,
    sandboxPolicyHash: input.sandboxPolicyHash,
    executionLimits: input.executionLimits,
    environment: Object.keys(input.containerEnvironment).sort().map((name) => ({
      name,
      valueHash: sha256(input.containerEnvironment[name]!),
    })),
  });
}

function buildRuntimeArgs(input: {
  configuration: ResolvedRunnerConfiguration;
  containerName: string;
  workspace: string;
  dependency: { path: string; contentHash: string } | null;
  environment: Readonly<Record<string, string>>;
  argv: readonly string[];
}): string[] {
  const { configuration } = input;
  // Podman's tmpfs parser does not accept Linux's nr_inodes mount option.
  // Its artifact tmpfs remains byte- and memory-cgroup-bounded, and the host
  // rejects an export above artifactFileLimit before producing authority.
  const artifactTmpfsOptions = [
    "rw",
    "noexec",
    "nosuid",
    "nodev",
    `size=${configuration.artifactByteLimit}`,
    ...(configuration.runtime.engine === "podman" ? [] : [`nr_inodes=${configuration.artifactFileLimit}`]),
    "mode=1777",
  ].join(",");
  const args = [
    ...(configuration.runtime.baseArgs ?? []),
    "run",
    "--pull=never",
    "--init",
    "--no-healthcheck",
    "--name", input.containerName,
    "--network", "none",
    "--ipc", configuration.runtime.engine === "podman" ? "private" : "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--pids-limit", String(configuration.pidsLimit),
    "--memory", configuration.memoryLimit,
    "--memory-swap", configuration.memoryLimit,
    "--cpus", configuration.cpuLimit,
    "--user", configuration.containerUser,
    "--workdir", "/workspace",
    "--mount", bindMount(input.workspace, "/workspace", true),
    "--tmpfs", `/artifacts:${artifactTmpfsOptions}`,
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${configuration.temporarySpaceBytes}`,
    "--entrypoint", input.argv[0]!,
  ];
  if (configuration.runtime.engine === "podman") {
    args.push("--read-only-tmpfs=false", "--image-volume=ignore");
  }
  if (input.dependency) args.push("--mount", bindMount(input.dependency.path, "/dependencies", true));
  for (const name of Object.keys(input.environment).sort()) {
    args.push("--env", `${name}=${input.environment[name]!}`);
  }
  args.push(configuration.imageDigest, ...input.argv.slice(1));
  return args;
}

async function runContainedProcess(input: {
  configuration: ResolvedRunnerConfiguration;
  runtimeArgs: readonly string[];
  runtimeEnvironment: NodeJS.ProcessEnv;
  containerName: string;
  timeoutMs: number;
  terminationGraceMs: number;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onTimeout: () => void;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  containmentOutcome: ContainmentOutcome;
}> {
  assertRuntimeExecutableIdentity(input.configuration);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.configuration.runtime.executable, [...input.runtimeArgs], {
      env: input.runtimeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    throw new ContainmentUnavailableError(`runtime spawn failed: ${errorMessage(error)}`);
  }
  child.stdout?.on("data", input.onStdout);
  child.stderr?.on("data", input.onStderr);

  let timedOut = false;
  let termination: Promise<boolean> | null = null;
  const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      input.onTimeout();
      termination = terminateContainer(
        input.configuration,
        input.runtimeEnvironment,
        input.containerName,
        input.terminationGraceMs,
        child,
      );
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new ContainmentUnavailableError(`runtime process failed: ${error.message}`));
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveCompletion({ exitCode, signal });
    });
  });
  const containmentOutcome: ContainmentOutcome = !timedOut
    ? "exited"
    : await (termination ?? Promise.resolve(false))
      ? "killed"
      : "unconfirmed";
  return { ...completion, containmentOutcome };
}

async function terminateContainer(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  containerName: string,
  graceMs: number,
  runtimeChild: ReturnType<typeof spawn>,
): Promise<boolean> {
  const graceSeconds = Math.max(1, Math.ceil(graceMs / 1_000));
  try {
    await runtimeControl(configuration, environment, ["stop", "--time", String(graceSeconds), containerName]);
  } catch {
    // The runtime control plane is no longer the executable that was bound.
    // Kill the local client so runContainedProcess can complete, but never
    // claim that the daemon-side container was stopped or removed.
    if (runtimeChild.exitCode === null && runtimeChild.signalCode === null) runtimeChild.kill("SIGKILL");
    return false;
  }
  if (runtimeChild.exitCode === null && runtimeChild.signalCode === null) runtimeChild.kill("SIGTERM");

  const started = Date.now();
  const clientForceKillAt = started + Math.min(graceMs, 1_000);
  const deadline = started + containerReapTimeoutMs;
  let absentSince: number | null = null;
  while (Date.now() < deadline) {
    let presence: Awaited<ReturnType<typeof containerPresence>>;
    try {
      const removed = await runtimeControl(configuration, environment, ["rm", "-f", containerName]);
      // A successful force-remove is deterministic evidence that the named
      // container is absent at this instant. When it fails, inspect/list are
      // still required to distinguish absence from a control-plane error.
      presence = removed
        ? "absent"
        : await containerPresence(configuration, environment, containerName);
    } catch {
      if (runtimeChild.exitCode === null && runtimeChild.signalCode === null) runtimeChild.kill("SIGKILL");
      return false;
    }
    if (
      Date.now() >= clientForceKillAt &&
      runtimeChild.exitCode === null &&
      runtimeChild.signalCode === null
    ) {
      runtimeChild.kill("SIGKILL");
    }
    const clientClosed = runtimeChild.exitCode !== null || runtimeChild.signalCode !== null;
    if (presence === "absent" && clientClosed) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= containerAbsenceConfirmationMs) return true;
    } else {
      absentSince = null;
    }
    await wait(containerReapPollMs);
  }
  if (runtimeChild.exitCode === null && runtimeChild.signalCode === null) runtimeChild.kill("SIGKILL");
  try {
    await runtimeControl(configuration, environment, ["rm", "-f", containerName]);
  } catch {
    return false;
  }
  return false;
}

async function containerPresence(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  containerName: string,
): Promise<"present" | "absent" | "unknown"> {
  if (await runtimeControl(configuration, environment, [
    "container", "inspect", "--format", "{{.Id}}", containerName,
  ])) return "present";
  // An inspect error is ambiguous: authorization failures, daemon errors,
  // and an absent container all use a non-zero exit. Only a successful list
  // that omits the exact generated name proves absence across Docker/Podman.
  const listing = await runtimeControlResult(configuration, environment, [
    "container", "ls", "--all", "--format", "{{.Names}}",
  ]);
  if (!listing.ok) return "unknown";
  return listing.stdout.split(/\r?\n/u).some((name) => name.trim() === containerName)
    ? "present"
    : "absent";
}

async function copyContainerArtifacts(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  containerName: string,
  destination: string,
): Promise<boolean> {
  return runtimeControl(configuration, environment, [
    "cp",
    `${containerName}:/artifacts/.`,
    destination,
  ]);
}

async function removeExitedContainer(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  containerName: string,
): Promise<boolean> {
  const deadline = Date.now() + containerReapTimeoutMs;
  while (Date.now() < deadline) {
    if (await runtimeControl(configuration, environment, ["rm", "-f", containerName])) return true;
    if (await containerPresence(configuration, environment, containerName) === "absent") return true;
    await wait(containerReapPollMs);
  }
  return false;
}

function runtimeControl(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<boolean> {
  return runtimeControlResult(configuration, environment, args).then((result) => result.ok);
}

function runtimeControlResult(
  configuration: ResolvedRunnerConfiguration,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  assertRuntimeExecutableIdentity(configuration);
  return new Promise((resolveControl) => {
    execFile(
      configuration.runtime.executable,
      [...(configuration.runtime.baseArgs ?? []), ...args],
      { env: environment, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => resolveControl({
        ok: !error,
        stdout: String(stdout),
      }),
    );
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function materializeCommit(
  repository: string,
  commit: string,
  workspace: string,
  fileLimit: number,
  byteLimit: number,
  configuration: ResolvedRunnerConfiguration,
): void {
  // Do not use `git archive`: repository-controlled export-ignore and
  // export-subst attributes would make the snapshot differ from the Git
  // tree. Reading raw blobs also avoids checkout filters and hooks.
  const listing = formalGitBuffer(["ls-tree", "-rlz", "--full-tree", commit], repository, configuration);
  const records = splitNul(listing);
  const destinations = new Set<string>();
  let totalBytes = 0;
  if (records.length > fileLimit) throw new Error(`Git tree exceeds snapshot file limit ${fileLimit}`);
  for (const record of records) {
    const separator = record.indexOf(0x09);
    if (separator < 0) throw new Error("Git tree contains an invalid entry");
    const header = record.subarray(0, separator).toString("ascii");
    // `git ls-tree --long` right-aligns blob sizes with one or more spaces.
    // Treat the padding as formatting, not part of the authoritative fields.
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)$/u.exec(header);
    if (!match) throw new Error(`Git tree contains an unsupported entry: ${header}`);
    const pathBytes = record.subarray(separator + 1);
    const path = pathBytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(pathBytes)) throw new Error("Git tree path is not valid UTF-8");
    const segments = path.split("/");
    if (!path || isAbsolute(path) || segments.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Git tree contains an unsafe path: ${path}`);
    }
    if (sep === "\\" && path.includes("\\")) throw new Error(`Git tree path is unsafe on Windows: ${path}`);
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Git tree entry has an invalid size: ${path}`);
    totalBytes += size;
    if (totalBytes > byteLimit) throw new Error(`Git tree exceeds snapshot byte limit ${byteLimit}`);
    const destination = resolve(workspace, ...segments);
    assertWithinDirectory(destination, workspace, "Git tree path");
    const normalizedDestination = process.platform === "win32" ? destination.toLowerCase() : destination;
    if (destinations.has(normalizedDestination)) throw new Error(`Git tree contains a colliding path: ${path}`);
    destinations.add(normalizedDestination);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    const content = formalGitBuffer(
      ["cat-file", "blob", match[2]!],
      repository,
      configuration,
      Math.max(1_024, size + 1),
    );
    if (content.length !== size) throw new Error(`Git blob size changed while materializing: ${path}`);
    if (match[1] === "120000") {
      const target = content.toString("utf8");
      if (!Buffer.from(target, "utf8").equals(content) || target.includes("\0")) {
        throw new Error(`Git symlink target is invalid UTF-8: ${path}`);
      }
      symlinkSync(target, destination);
    } else {
      writeFileSync(destination, content, { mode: match[1] === "100755" ? 0o755 : 0o644 });
      chmodSync(destination, match[1] === "100755" ? 0o755 : 0o644);
    }
  }
}

function gitCommandState(directory: string, configuration: ResolvedRunnerConfiguration): GitCommandState {
  const root = formalGit(["rev-parse", "--show-toplevel"], directory, configuration).trim();
  const commonRaw = formalGit(["rev-parse", "--git-common-dir"], root, configuration).trim();
  const commonDirectory = normalizedAbsolute(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  const head = formalGit(["rev-parse", "HEAD"], root, configuration).trim();
  const tree = formalGit(["rev-parse", `${head}^{tree}`], root, configuration).trim();
  const dirty = formalGit(["status", "--porcelain=v1", "--untracked-files=all"], root, configuration).length > 0;
  const branch = formalGit(["branch", "--show-current"], root, configuration).trim();
  const index = formalGit(["ls-files", "--stage", "-z"], root, configuration);
  const headReflog = formalGit(
    ["reflog", "show", "HEAD", "--format=%H%x00%gD%x00%gs"],
    root,
    configuration,
  );
  const controlHash = sha256(`${head}\0${branch}\0${index}\0${headReflog}`);
  return {
    root: normalizedAbsolute(root),
    commonDirectory,
    repositoryIdentity: sha256(`git-repository/v1\0${commonDirectory}`),
    head,
    tree,
    dirty,
    controlHash,
  };
}

function formalGit(
  args: readonly string[],
  cwd: string,
  configuration: ResolvedRunnerConfiguration,
): string {
  return formalGitBuffer(args, cwd, configuration).toString("utf8");
}

function formalGitBuffer(
  args: readonly string[],
  cwd: string,
  configuration: ResolvedRunnerConfiguration,
  maxBuffer = 64 * 1024 * 1024,
): Buffer {
  assertExecutableIdentity(
    configuration.gitExecutable,
    configuration.gitExecutableHash,
    "Git executable",
  );
  const formalArgs = [
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    ...args,
  ];
  try {
    return execFileSync(configuration.gitExecutable, formalArgs, {
      cwd,
      env: formalGitEnvironment(configuration.controlEnvironment),
      encoding: "buffer",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${errorMessage(error)}`);
  }
}

function formalGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !/^GIT_/iu.test(name)) result[name] = value;
  }
  result.GIT_NO_REPLACE_OBJECTS = "1";
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return result;
}

function assertExecutableIdentity(path: string, expectedHash: string, label: string): void {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    throw new ContainmentUnavailableError(`${label} is unavailable at its configured absolute path`);
  }
  accessSync(path, constants.X_OK);
  if (sha256(readFileSync(path)) !== expectedHash) {
    throw new ContainmentUnavailableError(`${label} content changed after configuration was bound`);
  }
}

function assertRuntimeExecutableIdentity(configuration: ResolvedRunnerConfiguration): void {
  assertExecutableIdentity(
    configuration.runtime.executable,
    configuration.runtimeExecutableHash,
    `${configuration.runtime.engine} runtime executable`,
  );
}

function splitNul(value: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    result.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new Error("Git tree listing is not NUL terminated");
  return result;
}

function hashDirectory(root: string, fileLimit: number, byteLimit: number): DirectoryManifest {
  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stats = lstatSync(absolute);
      const mode = stats.mode & 0o777;
      if (stats.isDirectory()) {
        hash.update(`d\0${path}\0${mode}\0`);
        visit(absolute);
        continue;
      }
      fileCount += 1;
      if (fileCount > fileLimit) throw new Error(`Directory manifest exceeds file limit ${fileLimit}`);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        totalBytes += Buffer.byteLength(target);
        if (totalBytes > byteLimit) throw new Error(`Directory manifest exceeds byte limit ${byteLimit}`);
        hash.update(`l\0${path}\0${mode}\0${target}\0`);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Directory manifest rejects special file: ${path}`);
      totalBytes += stats.size;
      if (totalBytes > byteLimit) throw new Error(`Directory manifest exceeds byte limit ${byteLimit}`);
      const content = readFileSync(absolute);
      if (content.length !== stats.size) throw new Error(`Directory file changed while hashing: ${path}`);
      hash.update(`f\0${path}\0${mode}\0${content.length}\0`).update(content).update("\0");
    }
  };
  visit(root);
  return { hash: hash.digest("hex"), fileCount, totalBytes };
}

function snapshotDirectory(
  sourceRoot: string,
  destinationRoot: string,
  fileLimit: number,
  byteLimit: number,
): DirectoryManifest {
  mkdirSync(destinationRoot, { recursive: false, mode: 0o755 });
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (source: string, destination: string): void => {
    for (const name of readdirSync(source).sort()) {
      const sourcePath = join(source, name);
      const destinationPath = join(destination, name);
      const stats = lstatSync(sourcePath);
      const mode = stats.mode & 0o777;
      if (stats.isDirectory()) {
        mkdirSync(destinationPath, { mode });
        chmodSync(destinationPath, mode);
        visit(sourcePath, destinationPath);
        continue;
      }
      fileCount += 1;
      if (fileCount > fileLimit) throw new Error(`Dependency snapshot exceeds file limit ${fileLimit}`);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(sourcePath);
        totalBytes += Buffer.byteLength(target);
        if (totalBytes > byteLimit) throw new Error(`Dependency snapshot exceeds byte limit ${byteLimit}`);
        symlinkSync(target, destinationPath);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Dependency snapshot rejects special file: ${sourcePath}`);
      totalBytes += stats.size;
      if (totalBytes > byteLimit) throw new Error(`Dependency snapshot exceeds byte limit ${byteLimit}`);
      const content = readFileSync(sourcePath);
      if (content.length !== stats.size) throw new Error(`Dependency file changed while snapshotting: ${sourcePath}`);
      writeFileSync(destinationPath, content, { mode });
      chmodSync(destinationPath, mode);
    }
  };
  visit(sourceRoot, destinationRoot);
  return hashDirectory(destinationRoot, fileLimit, byteLimit);
}

function bindMount(source: string, destination: string, readOnly: boolean): string {
  assertMountSafePath(source, "mount source");
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

function assertMountSafePath(path: string, name: string): void {
  if (path.includes(",") || path.includes("\0")) throw new Error(`${name} contains an unsupported mount character`);
}

function assertOutsideRepository(path: string, repositoryRoot: string, name: string): void {
  const relation = relative(normalizedAbsolute(repositoryRoot), path);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    throw new Error(`${name} must be outside the formal repository`);
  }
}

function assertWithinDirectory(path: string, root: string, name: string): void {
  const relation = relative(normalizedAbsolute(root), resolve(path));
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return;
  throw new Error(`${name} must be inside ${root}`);
}

function normalizedAbsolute(path: string): string {
  const absolute = resolve(path);
  const normalized = existsSync(absolute) ? realpathSync(absolute) : absolute;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedProspectiveAbsolute(path: string): string {
  let existingParent = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) break;
    missingSegments.unshift(basename(existingParent));
    existingParent = parent;
  }
  const normalizedParent = existsSync(existingParent) ? realpathSync(existingParent) : existingParent;
  const normalized = resolve(normalizedParent, ...missingSegments);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || trimmed.includes("\0")) throw new Error(`${name} is invalid`);
  return trimmed;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const remaining = limit - current.length;
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: chunk.length > remaining };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((part, index) => typeof part === "string" && part === expected[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
