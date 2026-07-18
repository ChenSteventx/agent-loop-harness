import { describe, expect, it } from "vitest";
import { normalizeFailureText } from "../src/failure-fingerprint.js";

describe("stable failure fingerprint normalization", () => {
  it("erases every declared noise class", () => {
    const noisy = [
      "FAIL 2026-07-18T14:03:22.123Z suite",
      "at /tmp/agent-loop-run-Xy12Ab/worktree/app.test.ts",
      "took 1234ms (pid 40213)",
      "commit 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e",
      "listening on 127.0.0.1:53127",
    ].join("\n");
    const normalized = normalizeFailureText(noisy);
    expect(normalized).not.toMatch(/2026-07-18/u);
    expect(normalized).not.toMatch(/40213|53127|1234ms/u);
    expect(normalized).not.toMatch(/9f8e7d6c/u);
    expect(normalized).not.toMatch(/agent-loop-run-Xy12Ab/u);
    expect(normalized).toContain("<timestamp>");
    expect(normalized).toContain("<tmp-path>");
    expect(normalized).toContain("<address>");
    expect(normalized).toContain("<hex>");
  });

  it("keeps the same signature for the same root cause across noisy reruns", () => {
    const runOne = "AssertionError: expected 4 to be 5\n  at math.test.ts:12:3\n  2026-07-18T10:00:00Z pid 111 /tmp/aaa111/log";
    const runTwo = "AssertionError: expected 4 to be 5\n  at math.test.ts:12:3\n  2026-07-19T22:41:09Z pid 999 /tmp/zzz999/log";
    expect(normalizeFailureText(runOne)).toBe(normalizeFailureText(runTwo));
  });

  it("still distinguishes genuinely different failures", () => {
    const missingModule = "Error: Cannot find module './billing'\n  at app.ts:3:1";
    const assertion = "AssertionError: expected 4 to be 5\n  at math.test.ts:12:3";
    expect(normalizeFailureText(missingModule)).not.toBe(normalizeFailureText(assertion));
    const differentLine = "AssertionError: expected 4 to be 5\n  at math.test.ts:99:3";
    expect(normalizeFailureText(assertion)).not.toBe(normalizeFailureText(differentLine));
  });
});
