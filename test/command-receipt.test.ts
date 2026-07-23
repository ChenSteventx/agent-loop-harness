import { describe, expect, it } from "vitest";
import {
  CommandRunner,
  commandReceiptMatchesExecution,
  commandReceiptProofProjection,
  commandReceiptProvesSuccess,
  type CommandRequest,
} from "../src/execution.js";
import { containedCommandExpectation, containedCommandResult, fakeOciImage } from "./oci-fixture.js";

const commit = "a".repeat(40);
const request: CommandRequest = {
  argv: ["node", "check.mjs"],
  cwd: "/fixture/repository",
  artifactDirectory: "/fixture/artifacts",
  policyVersion: "fixture/v1",
  configurationHash: "b".repeat(64),
};
const expectation = containedCommandExpectation(request, commit);

describe("CommandReceiptV2 authority predicate", () => {
  it("accepts only a stable contained zero-exit receipt", () => {
    const receipt = containedCommandResult(request, commit);
    expect(commandReceiptMatchesExecution(receipt, expectation)).toBe(true);
    expect(commandReceiptProvesSuccess(receipt, expectation)).toBe(true);

    const nonzero = { ...receipt, exitCode: 7 };
    expect(commandReceiptMatchesExecution(nonzero, expectation)).toBe(true);
    expect(commandReceiptProvesSuccess(nonzero, expectation)).toBe(false);
  });

  it.each([
    ["legacy schema", { schemaVersion: 1 }],
    ["wrong source", { sourceCommit: "c".repeat(40) }],
    ["post-command HEAD drift", { formalCommitAfter: "c".repeat(40) }],
    ["dirty formal repository", { formalDirtyAfter: true }],
    ["Git control-state drift", { formalControlHashAfter: "d".repeat(64) }],
    ["workspace mutation", { snapshotHashAfter: "e".repeat(64) }],
    ["dependency mutation", { containmentOutcome: "dependency-mutated" }],
    ["timeout", { timedOut: true, containmentOutcome: "killed" }],
    ["unconfirmed containment", { containmentOutcome: "unconfirmed" }],
    ["wrong image", { imageDigest: `fixture.invalid/other@sha256:${"f".repeat(64)}` }],
    ["wrong containment policy", { containmentSpecHash: "0".repeat(64) }],
    ["wrong repository identity", { repositoryIdentity: "0".repeat(64) }],
    ["wrong source tree", { sourceTree: "3".repeat(40) }],
    ["wrong sandbox policy", { sandboxPolicyHash: "0".repeat(64) }],
    ["well-formed forged command hash", { commandSpecHash: "0".repeat(64) }],
  ])("rejects %s", (_label, mutation) => {
    const receipt = { ...containedCommandResult(request, commit), ...mutation };
    expect(commandReceiptProvesSuccess(receipt, expectation)).toBe(false);
  });

  it("fails configuration closed for a remote Docker endpoint", async () => {
    const runner = new CommandRunner({
      runtime: { engine: "docker", executable: process.execPath },
      imageDigest: fakeOciImage,
      controlEnvironment: { DOCKER_HOST: "tcp://remote.example.invalid:2376" },
    });

    expect(runner.configurationBinding()).toBeNull();
    await expect(runner.run(request)).rejects.toThrow("DOCKER_HOST must identify a local");
  });

  it("fails Podman configuration closed instead of inheriting a remote host", async () => {
    const runner = new CommandRunner({
      runtime: { engine: "podman", executable: process.execPath },
      imageDigest: fakeOciImage,
      controlEnvironment: { CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock" },
    });

    expect(runner.configurationBinding()).toBeNull();
    await expect(runner.run(request)).rejects.toThrow("formal Podman execution forces local mode");
  });

  it("keeps diagnostic paths and timing out of the stable proof projection", () => {
    const receipt = containedCommandResult(request, commit);
    const diagnosticsChanged = {
      ...receipt,
      cwd: "/another/checkout",
      startedAt: "2026-02-02T00:00:00.000Z",
      durationMs: 999,
      stdoutPath: "/another/receipt/stdout.log",
      stderrPath: "/another/receipt/stderr.log",
    };
    expect(commandReceiptProofProjection(diagnosticsChanged)).toEqual(commandReceiptProofProjection(receipt));
    expect(commandReceiptProofProjection({ ...receipt, stdoutHash: "0".repeat(64) }))
      .not.toEqual(commandReceiptProofProjection(receipt));
  });
});
