import { describe, expect, it } from "vitest";
import {
  applyRiskEscalation,
  canBecomeReady,
  executionTemplates,
  routeRisk,
} from "../src/routing.js";

describe("fixed execution templates", () => {
  it("defines only the three bounded execution sequences", () => {
    expect(executionTemplates).toEqual({
      solo: { name: "solo", steps: ["author", "verification"], maximumRepairs: 1 },
      assisted: {
        name: "assisted",
        steps: ["explorer", "author", "verification"],
        maximumRepairs: 1,
      },
      reviewed: {
        name: "reviewed",
        steps: ["author", "verification", "independent-review", "repair", "verification", "independent-review"],
        maximumRepairs: 1,
      },
    });
  });
});

describe("risk routing", () => {
  it.each([
    ["low", "solo"],
    ["normal", "assisted"],
    ["high", "reviewed"],
    ["unknown", "assisted"],
  ] as const)("routes %s risk to %s by default", (risk, template) => {
    expect(routeRisk(risk)).toBe(template);
  });

  it("uses the cheapest valid template for low-risk work", () => {
    expect(routeRisk("low", ["reviewed", "solo", "assisted"])).toBe("solo");
    expect(routeRisk("low", ["reviewed", "assisted"])).toBe("assisted");
  });

  it("never chooses a template below the deterministic risk floor", () => {
    expect(routeRisk("normal", ["solo", "reviewed"])).toBe("reviewed");
    expect(() => routeRisk("high", ["solo", "assisted"])).toThrow("No valid execution template");
  });

  it("accepts escalation proposals but ignores attempts to lower the floor", () => {
    expect(applyRiskEscalation("normal", "high")).toBe("high");
    expect(applyRiskEscalation("high", "low")).toBe("high");
    expect(applyRiskEscalation("unknown", "low")).toBe("unknown");
  });

  it("allows unknown risk to investigate but not become ready", () => {
    expect(routeRisk("unknown")).toBe("assisted");
    expect(canBecomeReady("unknown")).toBe(false);
    expect(canBecomeReady("normal")).toBe(true);
  });
});
