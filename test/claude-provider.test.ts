import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeCodeArgs, ClaudeCodeAdapter, inferClaudeModelFamily } from "../src/claude-provider.js";

const roots: string[] = [];
const fixture = resolve("test/fixtures/fake-claude.mjs");

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "agent-loop-claude-"));
  roots.push(value);
  return value;
}

function request(directory: string, invocationId: string) {
  const schema = join(directory, "schema.json");
  writeFileSync(schema, JSON.stringify({ type: "object" }));
  return { invocationId, prompt: "fixture prompt", cwd: directory, artifactDirectory: join(directory, invocationId), outputSchemaPath: schema };
}

function adapter(mode: string, startupTimeoutMs = 1_000) {
  return new ClaudeCodeAdapter({
    executable: process.execPath,
    baseArgs: [fixture],
    model: "claude-sonnet-4-5",
    startupTimeoutMs,
    idleTimeoutMs: 1_000,
    absoluteTimeoutMs: 2_000,
    environment: { ...process.env, FAKE_CLAUDE_MODE: mode },
  });
}

afterEach(() => roots.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("ClaudeCodeAdapter", () => {
  it("reports identity, capabilities, structured output, session, and usage", async () => {
    const directory = root();
    const provider = adapter("success");
    const probe = await provider.probe();
    const result = await provider.run(request(directory, "run"));
    expect(probe).toMatchObject({ available: true, capabilities: { structuredOutput: true, resume: true } });
    expect(result.identity).toMatchObject({ provider: "anthropic-claude-code", model: "claude-sonnet-4-5", modelFamily: "sonnet", version: "2.1.209 (Claude Code)" });
    expect(result.threadId).toBe("claude-session-1");
    expect(result.finalOutput).toEqual({ status: "completed", source: "claude-fixture" });
    expect(result.usage).toEqual({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 6 });
  });

  it("resumes, classifies invalid output and quota, times out, and cancels", async () => {
    const directory = root();
    expect((await adapter("success").resume("existing-session", request(directory, "resume"))).threadId).toBe("existing-session");
    expect((await adapter("malformed").run(request(directory, "bad"))).failureClass).toBe("invalid_output");
    expect((await adapter("quota").run(request(directory, "quota"))).failureClass).toBe("quota");
    expect((await adapter("timeout", 50).run(request(directory, "timeout"))).failureClass).toBe("timeout");
    const provider = adapter("timeout", 2_000);
    const running = provider.run(request(directory, "cancel"));
    await new Promise((done) => setTimeout(done, 50));
    expect(await provider.cancel("cancel")).toBe(true);
    expect((await running).cancelled).toBe(true);
  });

  it("constructs only locally documented flags and derives known families", () => {
    expect(buildClaudeCodeArgs([], "sonnet", "{}", "session-1")).toEqual([
      "--print", "--output-format", "json", "--json-schema", "{}", "--model", "sonnet", "--resume", "session-1",
    ]);
    expect(inferClaudeModelFamily("claude-opus-4-1")).toBe("opus");
    expect(inferClaudeModelFamily("custom-model")).toBeNull();
  });
});
