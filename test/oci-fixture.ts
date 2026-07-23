import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CommandReceiptExpectation,
  CommandRequest,
  CommandResult,
  CommandRunnerOptions,
} from "../src/execution.js";

export const fakeOciImage = `fixture.invalid/agent-loop-node@sha256:${"0".repeat(64)}`;
const fakeOciRuntimeSource = resolve("test/fixtures/fake-oci-runtime.mjs");
export const fakeOciRuntime = join(tmpdir(), `agent-loop-fake-oci-runtime-${process.pid}.mjs`);
copyFileSync(fakeOciRuntimeSource, fakeOciRuntime);
chmodSync(fakeOciRuntime, 0o755);
process.once("exit", () => rmSync(fakeOciRuntime, { force: true }));

export function fakeOciRunnerOptions(stateDirectory: string, tracePath?: string): CommandRunnerOptions {
  mkdirSync(stateDirectory, { recursive: true });
  return {
    runtime: {
      engine: "docker",
      executable: process.execPath,
      baseArgs: [fakeOciRuntime],
    },
    imageDigest: fakeOciImage,
    controlEnvironment: {
      ...process.env,
      AGENT_LOOP_FAKE_OCI_STATE: stateDirectory,
      ...(tracePath ? { AGENT_LOOP_FAKE_OCI_TRACE: tracePath } : {}),
    },
  };
}

export function installFakeOciEnvironment(): void {
  const stateDirectory = resolve(tmpdir(), `agent-loop-fake-oci-${process.pid}`);
  mkdirSync(stateDirectory, { recursive: true });
  process.env.AGENT_LOOP_OCI_ENGINE = "docker";
  process.env.AGENT_LOOP_OCI_EXECUTABLE = process.execPath;
  process.env.AGENT_LOOP_OCI_BASE_ARGS_JSON = JSON.stringify([fakeOciRuntime]);
  process.env.AGENT_LOOP_OCI_IMAGE = fakeOciImage;
  process.env.AGENT_LOOP_FAKE_OCI_STATE = stateDirectory;
}

export function containedCommandResult(
  request: CommandRequest,
  commit: string,
  overrides: Partial<CommandResult> = {},
): CommandResult {
  const hash = "1".repeat(64);
  const expectation = containedCommandExpectation(request, commit);
  return {
    schemaVersion: 2,
    cwd: request.cwd,
    ...expectation,
    startedAt: "2026-01-01T00:00:00.000Z",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    containmentOutcome: "exited",
    stdoutPath: "",
    stderrPath: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutHash: hash,
    stderrHash: hash,
    artifactManifestHash: hash,
    snapshotScopeVersion: "git-tree/v1",
    snapshotHashBefore: hash,
    snapshotHashAfter: hash,
    commitBefore: commit,
    formalCommitAfter: commit,
    formalDirtyBefore: false,
    formalDirtyAfter: false,
    formalControlHashBefore: hash,
    formalControlHashAfter: hash,
    ...overrides,
  };
}

export function containedCommandExpectation(
  request: CommandRequest,
  commit: string,
): CommandReceiptExpectation {
  const hash = "1".repeat(64);
  return {
    repositoryIdentity: hash,
    sourceCommit: commit,
    sourceTree: "2".repeat(40),
    argv: [...request.argv],
    commandSpecHash: hash,
    policyVersion: request.policyVersion ?? null,
    configurationHash: request.configurationHash ?? null,
    imageDigest: fakeOciImage,
    containmentSpecHash: hash,
    dependencyInputHash: null,
    sandboxPolicyHash: hash,
  };
}
