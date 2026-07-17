import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvaluationStore } from "../src/evaluation/store.js";
import type { CanaryAssignment } from "../src/evolution/canary.js";
import { createInitialChampion, type ConfigurationVariant, type EvolutionConfiguration } from "../src/evolution/proposals.js";
import { RuntimeConfigResolver, type RuntimeConfigRepository } from "../src/runtime-config.js";

const championConfiguration: EvolutionConfiguration = {
  providerOrder: ["codex", "claude"], roleModels: {}, retryLimit: 1, timeoutMs: 60_000,
  contextRanking: ["task", "acceptance", "repository"],
  riskThresholds: { assisted: 1, reviewed: 2 }, memoryRetrievalEnabled: false,
};

describe("read-only Runtime Config resolution", () => {
  it("uses a Challenger only for an enabled low-risk assignment and falls back after rollback", () => {
    const champion = createInitialChampion({
      id: "champion", projectScope: "generic-node", version: "1", configuration: championConfiguration,
    });
    const challenger: ConfigurationVariant = {
      ...champion,
      id: "challenger",
      proposalId: "proposal",
      version: "2",
      status: "challenger",
      configuration: { ...championConfiguration, providerOrder: ["claude", "codex"], retryLimit: 2, timeoutMs: 90_000 },
      configurationHash: "challenger-hash",
      activatedAt: null,
    };
    const assignment: CanaryAssignment = {
      schemaVersion: 1, id: "assignment", projectScope: "generic-node", taskKey: "TASK-1", risk: "low",
      proposalId: "proposal", championId: champion.id, challengerId: challenger.id,
      selectedVariantId: challenger.id, selected: "challenger", bucket: 1, basisPoints: 100,
      extraBudgetTokens: 0, reason: "test", createdAt: "2026-07-16T00:00:00.000Z",
    };
    let challengerStatus: ConfigurationVariant["status"] = "challenger";
    const repository: RuntimeConfigRepository = {
      activeChampion: () => champion,
      getConfigurationVariant: () => ({ ...challenger, status: challengerStatus }),
      findCanaryAssignment: () => assignment,
    };
    const enabled = new RuntimeConfigResolver(repository, true);
    expect(enabled.resolve({ projectScope: "generic-node", taskKey: "TASK-1", effectiveRisk: "low" }))
      .toMatchObject({ configSource: "canary", configurationVariantId: "challenger", canaryAssignmentId: "assignment",
        configuration: { providerOrder: ["claude", "codex"], retryLimit: 2, timeoutMs: 90_000 } });
    expect(enabled.resolve({ projectScope: "generic-node", taskKey: "TASK-1", effectiveRisk: "high" }))
      .toMatchObject({ configSource: "champion", configurationVariantId: "champion", canaryAssignmentId: null });
    challengerStatus = "rolled-back";
    expect(enabled.resolve({ projectScope: "generic-node", taskKey: "TASK-1", effectiveRisk: "low" }))
      .toMatchObject({ configSource: "champion", configurationVariantId: "champion", canaryAssignmentId: null });
    expect(new RuntimeConfigResolver(repository).resolve({
      projectScope: "generic-node", taskKey: "TASK-1", effectiveRisk: "low",
    })).toMatchObject({ configSource: "champion", configurationVariantId: "champion" });
  });

  it("resolves from a read-only evaluation store that mechanically rejects writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-runtime-config-readonly-"));
    try {
      const path = join(directory, "evaluation.sqlite");
      const writable = new EvaluationStore(path);
      const champion = writable.installConfigurationVariant(createInitialChampion({
        id: "readonly-champion", projectScope: "generic-node", version: "1", configuration: championConfiguration,
      }));
      writable.close();
      const readOnly = new EvaluationStore(path, { readOnly: true });
      expect(new RuntimeConfigResolver(readOnly).resolve({
        projectScope: "generic-node", taskKey: "TASK-1", effectiveRisk: "low",
      })).toMatchObject({ configSource: "champion", configurationVariantId: champion.id });
      expect(() => readOnly.database.exec("DELETE FROM configuration_variants"))
        .toThrow(/readonly/iu);
      readOnly.close();
      expect(() => new EvaluationStore(join(directory, "missing.sqlite"), { readOnly: true }))
        .toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
