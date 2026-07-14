import { describe, expect, it } from "vitest";
import { createRun, resumeBlockedRun, transitionRun } from "../src/domain.js";

describe("run lifecycle", () => {
  it("follows open -> ready -> merged -> done", () => {
    const open = createRun("run-1", "task-1", "2026-01-01T00:00:00.000Z");
    const ready = transitionRun(open, "ready");
    const merged = transitionRun(ready, "merged", { mergeSha: "abc123" });
    const done = transitionRun(merged, "done");
    expect([open.status, ready.status, merged.status, done.status]).toEqual([
      "open",
      "ready",
      "merged",
      "done",
    ]);
    expect(merged.mergeSha).toBe("abc123");
  });

  it("rejects illegal transitions", () => {
    const run = createRun("run-1", "task-1");
    expect(() => transitionRun(run, "merged", { mergeSha: "abc" })).toThrow(
      "Illegal run transition",
    );
    expect(() => transitionRun(transitionRun(run, "failed"), "ready")).toThrow(
      "terminal run",
    );
  });

  it("preserves deterministic blocked metadata and resumes", () => {
    const blocked = transitionRun(createRun("run-1", "task-1"), "blocked", {
      blocked: {
        reason: "verification unavailable",
        checkpointRef: "op-7",
        resumeCommand: "loop resume run-1",
      },
    });
    expect(blocked.blocked).toEqual({
      previousStatus: "open",
      reason: "verification unavailable",
      checkpointRef: "op-7",
      resumeCommand: "loop resume run-1",
    });
    expect(resumeBlockedRun(blocked).status).toBe("open");
  });
});
