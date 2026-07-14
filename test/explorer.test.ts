import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExplorer } from "../src/explorer.js";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../src/provider.js";

class FakeExplorer implements ProviderAdapter {
  request: ProviderRunRequest | null = null;

  async probe() {
    return {
      available: true,
      identity: { provider: "fake", model: "explorer", executable: "fake", version: "1" },
      error: null,
    };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.request = request;
    return {
      invocationId: request.invocationId,
      ok: true,
      cancelled: false,
      identity: { provider: "fake", model: "explorer", executable: "fake", version: "1" },
      threadId: "private-transcript",
      events: [{ private: "not part of report" }],
      finalOutput: {
        relevantFiles: [{ path: "src/a.ts", symbols: ["a"] }],
        likelyAffectedTests: ["test/a.test.ts"],
        evidence: [{ path: "src/a.ts", observation: "a is the current caller" }],
        importantUnknowns: ["platform behavior"],
      },
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 17,
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 },
      failureClass: null,
      eventsPath: "events.jsonl",
      finalOutputPath: "final.json",
      stderrPath: "stderr.log",
    };
  }

  async cancel() { return false; }
}

describe("bounded Explorer", () => {
  it("uses the read-only tool contract and returns structured advisory metrics", async () => {
    const provider = new FakeExplorer();
    const result = await runExplorer(provider, {
      task: {
        id: "T", goal: "inspect", acceptance: ["report"], risk: "normal",
        verification: [{ id: "test", argv: ["npm", "test"] }],
      },
      baselineCommit: "abc",
      currentCommit: "def",
      allowedRepositoryRoots: ["/repo"],
      contextBudget: 123,
    }, {
      invocationId: "explorer",
      cwd: "/repo",
      artifactDirectory: "/artifacts",
      outputSchemaPath: "/schema.json",
    });

    expect(provider.request).toMatchObject({
      workspaceAccess: "read-only", allowedRepositoryRoots: ["/repo"], contextBudget: 123,
    });
    expect(provider.request?.additionalWritableDirectories).toBeUndefined();
    expect(result).toMatchObject({ costTokens: 15, latencyMs: 17, used: true });
    expect(result.report?.relevantFiles[0]).toEqual({ path: "src/a.ts", symbols: ["a"] });
    expect(JSON.stringify(result.report)).not.toContain("private-transcript");
  });

  it("fails closed on invalid output without treating the transcript as a report", async () => {
    const provider = new FakeExplorer();
    const original = provider.run.bind(provider);
    provider.run = async (request) => ({ ...(await original(request)), finalOutput: { prose: "guess" } });
    const result = await runExplorer(provider, {
      task: { id: "T", goal: "inspect", acceptance: ["report"], risk: "normal", verification: [{ id: "test", argv: ["npm"] }] },
      baselineCommit: "abc", currentCommit: "abc", allowedRepositoryRoots: ["/repo"], contextBudget: 1,
    }, { invocationId: "bad", cwd: "/repo", artifactDirectory: join("/tmp", "bad"), outputSchemaPath: "/schema" });
    expect(result.report).toBeNull();
    expect(result.used).toBe(false);
  });
});
