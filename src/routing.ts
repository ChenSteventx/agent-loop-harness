export const riskValues = ["low", "normal", "high", "unknown"] as const;

export type Risk = (typeof riskValues)[number];

export const executionTemplateNames = ["solo", "assisted", "reviewed"] as const;

export type ExecutionTemplateName = (typeof executionTemplateNames)[number];

export interface ExecutionTemplate {
  name: ExecutionTemplateName;
  requiresExplorer: boolean;
  requiresIndependentReview: boolean;
  maximumRepairs: 0 | 1;
}

export const executionTemplates: Readonly<Record<ExecutionTemplateName, ExecutionTemplate>> = {
  solo: {
    name: "solo",
    requiresExplorer: false,
    requiresIndependentReview: false,
    maximumRepairs: 1,
  },
  assisted: {
    name: "assisted",
    requiresExplorer: true,
    requiresIndependentReview: false,
    maximumRepairs: 1,
  },
  reviewed: {
    name: "reviewed",
    requiresExplorer: false,
    requiresIndependentReview: true,
    maximumRepairs: 1,
  },
};

const templateCost: Record<ExecutionTemplateName, number> = {
  solo: 0,
  assisted: 1,
  reviewed: 2,
};

const minimumTemplate: Record<Risk, ExecutionTemplateName> = {
  low: "solo",
  normal: "assisted",
  high: "reviewed",
  unknown: "assisted",
};

const knownRiskRank = { low: 0, normal: 1, high: 2 } as const;

export function routeRisk(
  risk: Risk,
  validTemplates: readonly ExecutionTemplateName[] = executionTemplateNames,
): ExecutionTemplateName {
  const minimumCost = templateCost[minimumTemplate[risk]];
  const selected = validTemplates
    .filter((template) => templateCost[template] >= minimumCost)
    .sort((left, right) => templateCost[left] - templateCost[right])[0];
  if (!selected) throw new Error(`No valid execution template can handle ${risk} risk`);
  return selected;
}

export function applyRiskEscalation(floor: Risk, proposal: Risk): Risk {
  if (floor === "unknown" || proposal === "unknown") return "unknown";
  return knownRiskRank[proposal] > knownRiskRank[floor] ? proposal : floor;
}

export function canBecomeReady(risk: Risk): boolean {
  return risk !== "unknown";
}
