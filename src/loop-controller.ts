import type { NextAction } from "./loop.js";

export interface LoopControllerPorts<T> {
  isActive(): boolean;
  status(): T;
  nextAction(): NextAction;
  recordAction(step: number, action: NextAction): void;
  execute(action: NextAction): Promise<T | null>;
  exhausted(): T;
}

export class LoopController<T> {
  constructor(private readonly maximumSteps: number) {
    if (!Number.isSafeInteger(maximumSteps) || maximumSteps <= 0) {
      throw new Error("Loop step budget must be a positive integer");
    }
  }

  async run(ports: LoopControllerPorts<T>): Promise<T> {
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
