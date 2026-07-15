import { describe, expect, it } from "vitest";
import { GenericNodeProjectAdapter } from "../src/project.js";
import type { TaskSpec } from "../src/task-spec.js";

const task: TaskSpec = {
  id: "RISK-1",
  goal: "Apply the requested change",
  acceptance: ["checks pass"],
  scope: ["src/ordinary/"],
  risk: "low",
  verification: [{ id: "check", argv: ["node", "check.mjs"] }],
};

describe("GenericNodeProjectAdapter risk floor", () => {
  it("raises security and permission paths to high risk without lowering caller risk", () => {
    const adapter = new GenericNodeProjectAdapter();
    expect(adapter.minimumRisk({ task })).toBe("low");
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/security/"] } })).toBe("high");
    expect(adapter.minimumRisk({ task, changedFiles: ["src/permissions/access.ts"] })).toBe("high");
    expect(adapter.minimumRisk({ task, changedFiles: [".github/workflows/release.yml"] })).toBe("high");
  });
});
