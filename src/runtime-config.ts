import type { CanaryAssignment } from "./evolution/canary.js";
import type { ConfigurationVariant, EvolutionConfiguration } from "./evolution/proposals.js";
import type { Risk } from "./routing.js";

export type ConfigSource = "default" | "champion" | "canary";

export interface RuntimeConfiguration {
  configurationVariantId: string | null;
  configurationHash: string | null;
  canaryAssignmentId: string | null;
  configSource: ConfigSource;
  configuration: EvolutionConfiguration | null;
}

export interface RuntimeConfigRepository {
  activeChampion(projectScope: string): ConfigurationVariant | null;
  getConfigurationVariant(id: string): ConfigurationVariant | null;
  findCanaryAssignment(projectScope: string, taskKey: string): CanaryAssignment | null;
}

export class RuntimeConfigResolver {
  constructor(
    private readonly repository: RuntimeConfigRepository,
    private readonly canaryEnabled = false,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  resolve(input: { projectScope: string; taskKey: string; effectiveRisk: Risk }): RuntimeConfiguration {
    const champion = this.repository.activeChampion(input.projectScope);
    if (!champion) return defaultRuntimeConfiguration();
    if (!this.canaryEnabled || input.effectiveRisk !== "low") return fromVariant(champion, null, "champion");
    const assignment = this.repository.findCanaryAssignment(input.projectScope, input.taskKey);
    // Assignments bound to a retired Champion, mismatched variants, or an
    // expired (or legacy pre-expiry) approval fall back to the Champion.
    if (!assignment || assignment.risk !== "low" || assignment.selected !== "challenger" ||
        assignment.championId !== champion.id ||
        assignment.selectedVariantId !== assignment.challengerId ||
        !assignment.expiresAt || assignment.expiresAt <= this.now()) {
      return fromVariant(champion, null, "champion");
    }
    const challenger = this.repository.getConfigurationVariant(assignment.selectedVariantId);
    if (!challenger || challenger.status !== "challenger" || challenger.projectScope !== input.projectScope) {
      return fromVariant(champion, null, "champion");
    }
    return fromVariant(challenger, assignment.id, "canary");
  }

  close(): void {
    const repository = this.repository as RuntimeConfigRepository & { close?: () => void };
    repository.close?.();
  }
}

export function defaultRuntimeConfiguration(): RuntimeConfiguration {
  return {
    configurationVariantId: null,
    configurationHash: null,
    canaryAssignmentId: null,
    configSource: "default",
    configuration: null,
  };
}

function fromVariant(
  variant: ConfigurationVariant,
  canaryAssignmentId: string | null,
  configSource: Exclude<ConfigSource, "default">,
): RuntimeConfiguration {
  return {
    configurationVariantId: variant.id,
    configurationHash: variant.configurationHash,
    canaryAssignmentId,
    configSource,
    configuration: variant.configuration,
  };
}
