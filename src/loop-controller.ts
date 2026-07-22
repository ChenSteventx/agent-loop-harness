import type { NextAction } from "./loop.js";

export interface LoopControllerPorts<T, A = NextAction> {
  isActive(): boolean;
  status(): T;
  nextAction(): A;
  recordAction(step: number, action: A): void;
  execute(action: A): Promise<T | null>;
  exhausted(): T;
}

export class LoopController<T, A = NextAction> {
  constructor(private readonly maximumSteps: number) {
    if (!Number.isSafeInteger(maximumSteps) || maximumSteps <= 0) {
      throw new Error("Loop step budget must be a positive integer");
    }
  }

  async run(ports: LoopControllerPorts<T, A>): Promise<T> {
    for (let step = 1; step <= this.maximumSteps; step += 1) {
      if (!ports.isActive()) return ports.status();
      const action = ports.nextAction();
      ports.recordAction(step, action);
      const terminal = await ports.execute(action);
      if (terminal) return terminal;
    }
    return ports.exhausted();
  }
}
