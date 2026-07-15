import type { ProviderAdapter } from "./provider.js";
import {
  ProviderSupervisor,
  type ProviderSupervisorOptions,
  type ProviderSupervisorPersistence,
} from "./provider-supervisor.js";
import type { Risk } from "./routing.js";
import type { SqliteStore } from "./store.js";

export const providerProfileNames = ["CODEX_PRIMARY", "CLAUDE_PRIMARY"] as const;
export type ProviderProfileName = (typeof providerProfileNames)[number];
export type ProviderFamily = "codex" | "claude" | "deepseek";

export interface ConfiguredProvider {
  adapter: ProviderAdapter;
  family: ProviderFamily;
  name: string;
}

export interface ProviderProfile {
  name: ProviderProfileName;
  author: ConfiguredProvider;
  fallbackAuthor: ConfiguredProvider;
  reviewer: ConfiguredProvider;
  fallbackReviewer: ConfiguredProvider;
}

export function createProviderProfile(
  name: ProviderProfileName,
  providers: Readonly<Record<ProviderFamily, ConfiguredProvider>>,
): ProviderProfile {
  for (const family of Object.keys(providers) as ProviderFamily[]) {
    if (providers[family].family !== family) {
      throw new Error(`Provider ${providers[family].name} is registered under the wrong family`);
    }
  }
  return name === "CODEX_PRIMARY"
    ? {
        name,
        author: providers.codex,
        fallbackAuthor: providers.claude,
        reviewer: providers.claude,
        fallbackReviewer: providers.deepseek,
      }
    : {
        name,
        author: providers.claude,
        fallbackAuthor: providers.codex,
        reviewer: providers.codex,
        fallbackReviewer: providers.deepseek,
      };
}

export interface ReviewAvailability {
  primaryAvailable: boolean;
  fallbackAvailable: boolean;
}

export type ReviewRoutingDecision =
  | { disposition: "independent" | "fallback"; reviewer: ConfiguredProvider }
  | { disposition: "advisory"; reviewer: ConfiguredProvider | null }
  | { disposition: "needs-human"; reviewer: null };

export function selectReviewer(
  profile: ProviderProfile,
  risk: Risk,
  availability: ReviewAvailability,
): ReviewRoutingDecision {
  if (availability.primaryAvailable && isIndependentReceipt(profile.author, profile.reviewer)) {
    return { disposition: "independent", reviewer: profile.reviewer };
  }
  if (availability.fallbackAvailable && isIndependentReceipt(profile.author, profile.fallbackReviewer)) {
    return { disposition: "fallback", reviewer: profile.fallbackReviewer };
  }
  if (risk === "high") return { disposition: "needs-human", reviewer: null };
  return { disposition: "advisory", reviewer: availability.primaryAvailable ? profile.reviewer : null };
}

export function isIndependentReceipt(author: ConfiguredProvider, reviewer: ConfiguredProvider): boolean {
  return author.family !== reviewer.family && author.adapter !== reviewer.adapter;
}

export function independentReviewCandidates(
  profile: ProviderProfile,
  actualAuthor: ConfiguredProvider = profile.author,
): ConfiguredProvider[] {
  return [profile.reviewer, profile.fallbackReviewer].filter((candidate, index, candidates) =>
    isIndependentReceipt(actualAuthor, candidate) &&
    candidate.adapter.workspaceIsolation?.readOnly === "enforced" &&
    candidates.findIndex((item) => item.adapter === candidate.adapter) === index
  );
}

export function workspaceRoleCandidates(
  profile: ProviderProfile,
  access: "read-only" | "workspace-write",
): ConfiguredProvider[] {
  return [profile.author, profile.fallbackAuthor].filter((candidate, index, candidates) =>
    candidate.adapter.workspaceIsolation?.[access === "read-only" ? "readOnly" : "workspaceWrite"] === "enforced" &&
    candidates.findIndex((item) => item.adapter === candidate.adapter) === index
  );
}

export function createReviewerSupervisor(
  profile: ProviderProfile,
  options: Omit<ProviderSupervisorOptions, "adapters">,
): ProviderSupervisor {
  return new ProviderSupervisor({ ...options, adapters: [profile.reviewer.adapter, profile.fallbackReviewer.adapter] });
}

export function withFallbackOutbox(
  persistence: ProviderSupervisorPersistence,
  store: SqliteStore,
  runId: string,
): ProviderSupervisorPersistence {
  return {
    saveCheckpoint: (checkpoint) => persistence.saveCheckpoint(checkpoint),
    saveFailure: (evidence) => persistence.saveFailure(evidence),
    saveFallback: (record) => {
      store.enqueueOutbox(runId, "provider-fallback", record);
      persistence.saveFallback(record);
    },
  };
}
