import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { operationInputHash } from "./bindings.js";
import type { RunBindingV2, WorkflowTraversal } from "./domain.js";
import { SqliteStore } from "./store.js";
import { validateWorkflowTopology } from "./workflow-validator.js";

export interface FrozenTopologyView {
  topologyHash: string;
  manifest: RunBindingV2["workflow"]["manifest"];
  traversals: WorkflowTraversal[];
  pendingTraversal: WorkflowTraversal | null;
  budgetUsage: Record<string, number>;
}

export function inspectFrozenTopology(loopHome: string, runId: string): FrozenTopologyView {
  const statePath = resolve(loopHome, "state.sqlite");
  if (!existsSync(statePath)) throw new Error(`No formal development state at ${statePath}`);
  const store = new SqliteStore(statePath, { readOnly: true });
  try {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const binding = run.binding;
    if (!binding) throw new Error(`Run ${runId} has no immutable binding`);
    if (binding.version !== 2) throw new Error("Run predates frozen workflow topology; start a new run");
    validateWorkflowTopology(binding.workflow.manifest);
    if (binding.workflow.manifest.template !== binding.executionTemplate) {
      throw new Error("Frozen workflow template does not match the execution template");
    }
    if (operationInputHash(binding.workflow.manifest) !== binding.workflow.topologyHash) {
      throw new Error("Frozen workflow topology hash does not match its manifest");
    }
    return {
      topologyHash: binding.workflow.topologyHash,
      manifest: binding.workflow.manifest,
      traversals: store.listWorkflowTraversals(runId),
      pendingTraversal: store.getPendingWorkflowTraversal(runId),
      budgetUsage: Object.fromEntries(
        binding.workflow.manifest.budgets.map((budget) => [
          budget.id,
          store.workflowBudgetUsage(runId, budget.id),
        ]),
      ),
    };
  } finally {
    store.close();
  }
}
