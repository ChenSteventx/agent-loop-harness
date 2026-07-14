import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  additionalWritableDirectoryArgs,
  CodexCliAdapter,
  resolveCodexLaunch,
  windowsSandboxConfigArgs,
} from "../src/provider.js";

const temporaryDirectories: string[] = [];
const fixture = resolve("test/fixtures/fake-codex.mjs");

function request(root: string, invocationId = "invocation-1") {
  const schema = join(root, "schema.json");
  writeFileSync(schema, JSON.stringify({ type: "object" }));
  return {
    invocationId,
    prompt: "Perform the bounded fixture task.",
    cwd: root,
    artifactDirectory: join(root, "artifacts", invocationId),
    outputSchemaPath: schema,
  };
}

function adapter(mode: string, timeouts?: { startupTimeoutMs?: number; idleTimeoutMs?: number; absoluteTimeoutMs?: number }) {
  return new CodexCliAdapter({
    executable: process.execPath,
    baseArgs: [fixture],
    provider: "fixture-provider",
    model: "fixture-model",
    sandbox: "workspace-write",
    startupTimeoutMs: timeouts?.startupTimeoutMs ?? 1_000,
    idleTimeoutMs: timeouts?.idleTimeoutMs ?? 1_000,
    absoluteTimeoutMs: timeouts?.absoluteTimeoutMs ?? 2_000,
    environment: { ...process.env, FAKE_CODEX_MODE: mode },
  });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-provider-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexCliAdapter", () => {
  it("probes process identity and captures successful JSONL facts", async () => {
    const root = temporaryRoot();
    const provider = adapter("success");
    const probe = await provider.probe();
    const result = await provider.run(request(root));

    expect(probe.available).toBe(true);
    expect(probe.identity.version).toBe("fake-codex 1.0.0");
    expect(result.ok).toBe(true);
    expect(result.identity).toMatchObject({ provider: "fixture-provider", model: "fixture-model" });
    expect(result.threadId).toBe("fake-thread-1");
    expect(result.finalOutput).toEqual({ status: "completed", source: "fixture" });
    expect(result.usage).toEqual({ inputTokens: 12, cachedInputTokens: 3, outputTokens: 7 });
    expect(result.exitCode).toBe(0);
  });

  it("classifies malformed JSONL as invalid output", async () => {
    const result = await adapter("malformed").run(request(temporaryRoot()));
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("invalid_output");
  });

  it("classifies quota and non-zero failures from process facts", async () => {
    const quota = await adapter("quota").run(request(temporaryRoot(), "quota"));
    expect(quota.exitCode).toBe(1);
    expect(quota.failureClass).toBe("quota");

    const nonzero = await adapter("nonzero").run(request(temporaryRoot(), "nonzero"));
    expect(nonzero.exitCode).toBe(2);
    expect(nonzero.failureClass).toBe("unknown");
  });

  it("enforces startup timeout and supports cancellation", async () => {
    const root = temporaryRoot();
    const timed = await adapter("timeout", { startupTimeoutMs: 100, absoluteTimeoutMs: 1_000 }).run(
      request(root, "timed"),
    );
    expect(timed.ok).toBe(false);
    expect(timed.failureClass).toBe("timeout");

    const provider = adapter("timeout", { startupTimeoutMs: 5_000, absoluteTimeoutMs: 5_000 });
    const running = provider.run(request(root, "cancelled"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(await provider.cancel("cancelled")).toBe(true);
    const cancelled = await running;
    expect(cancelled.cancelled).toBe(true);
  });

  it("enforces idle timeout after startup activity", async () => {
    const timed = await adapter("idle", {
      startupTimeoutMs: 1_000,
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 2_000,
    }).run(request(temporaryRoot(), "idle"));
    expect(timed.ok).toBe(false);
    expect(timed.threadId).toBe("fake-thread-idle");
    expect(timed.failureClass).toBe("timeout");
  });
});

describe("Codex executable resolution", () => {
  it("adds only explicitly supplied writable directories", () => {
    const root = temporaryRoot();
    expect(additionalWritableDirectoryArgs([join(root, ".git")])).toEqual([
      "--add-dir",
      resolve(root, ".git"),
    ]);
    expect(additionalWritableDirectoryArgs(undefined)).toEqual([]);
  });

  it("selects the native Windows sandbox without affecting WSL", () => {
    expect(windowsSandboxConfigArgs("win32", {})).toEqual([
      "-c",
      'windows.sandbox="elevated"',
    ]);
    expect(
      windowsSandboxConfigArgs("win32", { CODEX_WINDOWS_SANDBOX: "unelevated" }),
    ).toEqual(["-c", 'windows.sandbox="unelevated"']);
    expect(windowsSandboxConfigArgs("linux", {})).toEqual([]);
    expect(() =>
      windowsSandboxConfigArgs("win32", { CODEX_WINDOWS_SANDBOX: "invalid" }),
    ).toThrow("elevated or unelevated");
  });

  it("uses the npm Codex JavaScript entry on Windows", () => {
    const root = temporaryRoot();
    const script = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(resolve(script, ".."), { recursive: true });
    writeFileSync(script, "process.stdout.write('fixture')\n");

    expect(
      resolveCodexLaunch({
        platform: "win32",
        nodeExecutable: "C:\\runtime\\node.exe",
        environment: { PATH: root },
      }),
    ).toEqual({ executable: "C:\\runtime\\node.exe", baseArgs: [script] });
  });

  it("keeps the native command interface for WSL and supports CODEX_BIN", () => {
    expect(resolveCodexLaunch({ platform: "linux", environment: {} })).toEqual({
      executable: "codex",
      baseArgs: [],
    });
    expect(
      resolveCodexLaunch({
        platform: "linux",
        nodeExecutable: "/usr/bin/node",
        environment: { CODEX_BIN: "/opt/codex/bin/codex.js" },
      }),
    ).toEqual({ executable: "/usr/bin/node", baseArgs: ["/opt/codex/bin/codex.js"] });
  });
});
