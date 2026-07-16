import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAdapter } from "../src/pi-provider.js";

const roots: string[] = [];
const fixture = resolve("test/fixtures/fake-pi.mjs");
function root() { const value = mkdtempSync(join(tmpdir(), "agent-loop-pi-")); roots.push(value); return value; }
function request(directory: string, invocationId: string) { const schema = join(directory, "schema.json"); writeFileSync(schema, JSON.stringify({ type: "object" })); return { invocationId, prompt: "review only", cwd: directory, artifactDirectory: join(directory, invocationId), outputSchemaPath: schema, workspaceAccess: "read-only" as const }; }
function adapter(mode: string, route: "highCapability" | "fastAuxiliary" = "highCapability", executable = process.execPath, timeout = 1_000) { return new PiAdapter({ executable, baseArgs: executable === process.execPath ? [fixture] : [], provider: "configured-provider", routes: { highCapability: { id: "configured-high", displayName: "Configured High" }, fastAuxiliary: { id: "configured-fast" } }, route, startupTimeoutMs: timeout, idleTimeoutMs: 1_000, absoluteTimeoutMs: 2_000, environment: { ...process.env, FAKE_PI_MODE: mode } }); }
afterEach(() => roots.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("PiAdapter", () => {
  it("does not claim workspace isolation that the CLI cannot enforce", () => {
    expect(adapter("success").workspaceIsolation).toEqual({ readOnly: "unverified", workspaceWrite: "unverified" });
  });

  it("probes RPC and model metadata, then captures identity and usage", async () => {
    const directory = root(); const provider = adapter("success"); const probe = await provider.probe(); const result = await provider.run(request(directory, "run"));
    expect(probe).toMatchObject({ available: true, capabilities: { structuredOutput: true, resume: false }, identity: { provider: "configured-provider", model: "configured-high", modelDisplayName: "Probe High", version: "1.2.3" } });
    expect(result).toMatchObject({ ok: true, finalOutput: { status: "reviewed" }, usage: { inputTokens: 12, outputTokens: 3 }, failureClass: null });
  });
  it("supports the configured fast route using probed display metadata", async () => { expect((await adapter("success", "fastAuxiliary").probe()).identity).toMatchObject({ model: "configured-fast", modelDisplayName: "Probe Fast" }); });
  it("classifies malformed, transient, quota, unavailable, timeout, and cancellation", async () => {
    const directory = root();
    for (const [mode, expected] of [["malformed", "invalid_output"], ["transient", "transient"], ["quota", "quota"]] as const) { const provider = adapter(mode); await provider.probe(); expect((await provider.run(request(directory, mode))).failureClass).toBe(expected); }
    expect((await adapter("success", "highCapability", join(directory, "missing-pi")).probe()).available).toBe(false);
    const timeoutProvider = adapter("timeout", "highCapability", process.execPath, 30); await timeoutProvider.probe(); expect((await timeoutProvider.run(request(directory, "timeout"))).failureClass).toBe("timeout");
    const provider = adapter("timeout", "highCapability", process.execPath, 2_000); await provider.probe(); const running = provider.run(request(directory, "cancel")); await new Promise((done) => setTimeout(done, 50)); expect(await provider.cancel("cancel")).toBe(true); expect((await running).cancelled).toBe(true);
  }, 15_000);
});
