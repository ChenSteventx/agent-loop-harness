import { describe, expect, it, vi } from "vitest";
import { LoopController } from "../src/loop-controller.js";

describe("LoopController", () => {
  it("supports arbitrary deterministic decision values", async () => {
    type Decision = { edgeId: string; value: number };
    const decisions: Decision[] = [
      { edgeId: "entry.author", value: 1 },
      { edgeId: "author.checkpoint", value: 2 },
    ];
    const recorded: Array<{ step: number; decision: Decision }> = [];
    let index = 0;

    const result = await new LoopController<string, Decision>(4).run({
      isActive: () => true,
      status: () => "active",
      nextAction: () => decisions[index]!,
      recordAction: (step, decision) => recorded.push({ step, decision }),
      execute: async () => {
        index += 1;
        return index === decisions.length ? "terminal" : null;
      },
      exhausted: () => "exhausted",
    });

    expect(result).toBe("terminal");
    expect(recorded).toEqual([
      { step: 1, decision: decisions[0] },
      { step: 2, decision: decisions[1] },
    ]);
  });

  it("returns current status without selecting work when inactive", async () => {
    const nextAction = vi.fn(() => "work");
    const result = await new LoopController<string, string>(2).run({
      isActive: () => false,
      status: () => "stopped",
      nextAction,
      recordAction: vi.fn(),
      execute: vi.fn(async () => null),
      exhausted: () => "exhausted",
    });

    expect(result).toBe("stopped");
    expect(nextAction).not.toHaveBeenCalled();
  });

  it("records every selected decision and delegates exhaustion at the exact step budget", async () => {
    const recordAction = vi.fn();
    const execute = vi.fn(async () => null);
    const exhausted = vi.fn(() => "exhausted");

    const result = await new LoopController<string, string>(2).run({
      isActive: () => true,
      status: () => "active",
      nextAction: () => "work",
      recordAction,
      execute,
      exhausted,
    });

    expect(result).toBe("exhausted");
    expect(recordAction.mock.calls).toEqual([[1, "work"], [2, "work"]]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(exhausted).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maximum step budget %s",
    (maximumSteps) => {
      expect(() => new LoopController(maximumSteps)).toThrow("Loop step budget must be a positive integer");
    },
  );
});
