export interface ReadinessInputs {
  realRunCount: number;
  resolvedFindingCount: number;
  exactReplayCount: number;
  goldenTaskCount: number;
  holdoutTaskCount: number;
  completedOfflineComparisons: number;
  completedShadowRuns: number;
  humanCanaryApproval: boolean;
}

export interface ReadinessThresholds {
  optimizationRealRuns: number;
  optimizationResolvedFindings: number;
  optimizationExactReplays: number;
  optimizationGoldenTasks: number;
  optimizationHoldoutTasks: number;
  canaryOfflineComparisons: number;
  canaryShadowRuns: number;
}

export interface ReadinessReport {
  optimizationReady: boolean;
  canaryReady: boolean;
  inputs: ReadinessInputs;
  thresholds: ReadinessThresholds;
  optimizationBlockers: string[];
  canaryBlockers: string[];
}

export const defaultReadinessThresholds: ReadinessThresholds = {
  optimizationRealRuns: 20,
  optimizationResolvedFindings: 10,
  optimizationExactReplays: 5,
  optimizationGoldenTasks: 5,
  optimizationHoldoutTasks: 5,
  canaryOfflineComparisons: 3,
  canaryShadowRuns: 10,
};

export function evaluateReadiness(
  inputs: ReadinessInputs,
  thresholds: ReadinessThresholds = defaultReadinessThresholds,
): ReadinessReport {
  validateCounts(inputs, thresholds);
  const optimizationBlockers = [
    below(inputs.realRunCount, thresholds.optimizationRealRuns, "real development runs"),
    below(inputs.resolvedFindingCount, thresholds.optimizationResolvedFindings, "human or machine resolved Findings"),
    below(inputs.exactReplayCount, thresholds.optimizationExactReplays, "exact historical replays"),
    below(inputs.goldenTaskCount, thresholds.optimizationGoldenTasks, "Golden Tasks"),
    below(inputs.holdoutTaskCount, thresholds.optimizationHoldoutTasks, "Holdout Tasks"),
  ].filter((value): value is string => value !== null);
  const optimizationReady = optimizationBlockers.length === 0;
  const canaryBlockers = [
    ...optimizationBlockers,
    below(inputs.completedOfflineComparisons, thresholds.canaryOfflineComparisons, "completed offline comparisons"),
    below(inputs.completedShadowRuns, thresholds.canaryShadowRuns, "completed Shadow runs"),
    inputs.humanCanaryApproval ? null : "human Canary approval is missing",
  ].filter((value): value is string => value !== null);
  return {
    optimizationReady,
    canaryReady: optimizationReady && canaryBlockers.length === 0,
    inputs: { ...inputs },
    thresholds: { ...thresholds },
    optimizationBlockers,
    canaryBlockers,
  };
}

function below(actual: number, required: number, label: string): string | null {
  return actual >= required ? null : `${label}: ${actual}/${required}`;
}

function validateCounts(inputs: ReadinessInputs, thresholds: ReadinessThresholds): void {
  for (const [name, value] of Object.entries({ ...inputs, ...thresholds })) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
}
