import { describe, expect, it } from "vitest";
import { parseTaskSpec } from "../src/task-spec.js";

const valid = {
  id: "TASK-1",
  goal: "Make a deterministic change",
  acceptance: ["The check passes"],
  risk: "low",
  verification: [{ id: "test", argv: ["npm", "test"] }],
};

describe("task spec", () => {
  it("parses the minimal task", () => {
    expect(parseTaskSpec(valid)).toEqual(valid);
  });

  it.each(["low", "normal", "high", "unknown"] as const)("accepts %s risk", (risk) => {
    expect(parseTaskSpec({ ...valid, risk }).risk).toBe(risk);
  });

  it("rejects the replaced medium risk value", () => {
    expect(() => parseTaskSpec({ ...valid, risk: "medium" })).toThrow();
  });

  it("rejects incomplete specs", () => {
    expect(() => parseTaskSpec({ ...valid, acceptance: [] })).toThrow();
    expect(() => parseTaskSpec({ ...valid, verification: [{ id: "test", argv: [""] }] })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseTaskSpec({ ...valid, providerPrompt: "trust me" })).toThrow();
  });
});
