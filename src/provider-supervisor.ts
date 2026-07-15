import { resolve } from "node:path";
import {
  classifyProviderFailure,
  type ProviderAdapter,
  type ProviderFailureClass,
  type ProviderRunRequest,
  type ProviderRunResult,
} from "./provider.js";

export type ProviderSupervisorDisposition = "succeeded" | "fallback" | "blocked";

export interface ProviderFailureEvidence {
  provider: string;
  invocationId: string;
  attempt: number;
  failureClass: ProviderFailureClass;
  exitCode: number | null;
  retryAfterMs: number | null;
}

export interface ProviderFallbackRecord {
  fromProvider: string;
  reason: ProviderFailureClass | "cooldown";
}

export interface ProviderSupervisorPersistence {
  saveCheckpoint(checkpoint: {
    invocationId: string;
    provider: string;
    threadId: string | null;
    selectedAdapterIndex: number;
    attempt: number;
    result: ProviderRunResult;
  }): void;
  saveFailure(evidence: ProviderFailureEvidence): void;
  saveFallback(record: ProviderFallbackRecord): void;
}

export interface ProviderSupervisorResult {
  disposition: ProviderSupervisorDisposition;
  result: ProviderRunResult | null;
  selectedAdapterIndex: number | null;
  failures: ProviderFailureEvidence[];
  fallbackHistory: ProviderFallbackRecord[];
  recoveryCommand: string | null;
}

export type ProviderResultValidator = (result: ProviderRunResult) => boolean;

export interface ProviderSupervisorOptions {
  adapters: readonly ProviderAdapter[];
  persistence: ProviderSupervisorPersistence;
  authRecoveryCommand: string;
  unknownRecoveryCommand: string;
  backoffMs?: number;
  cooldownThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CooldownState {
  failures: number;
  until: number;
  provider: string;
}

export class ProviderSupervisor {
  private readonly adapters: readonly ProviderAdapter[];
  private readonly persistence: ProviderSupervisorPersistence;
  private readonly authRecoveryCommand: string;
  private readonly unknownRecoveryCommand: string;
  private readonly backoffMs: number;
  private readonly cooldownThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cooldowns = new Map<ProviderAdapter, CooldownState>();

  constructor(options: ProviderSupervisorOptions) {
    if (options.adapters.length === 0) throw new Error("Provider supervisor requires at least one adapter");
    if (!options.authRecoveryCommand.trim()) throw new Error("Auth recovery command is required");
    if (!options.unknownRecoveryCommand.trim()) throw new Error("Unknown failure recovery command is required");
    this.adapters = options.adapters;
    this.persistence = options.persistence;
    this.authRecoveryCommand = options.authRecoveryCommand;
    this.unknownRecoveryCommand = options.unknownRecoveryCommand;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.cooldownThreshold = options.cooldownThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async run(
    request: ProviderRunRequest,
    validateResult: ProviderResultValidator = () => true,
  ): Promise<ProviderSupervisorResult> {
    const failures: ProviderFailureEvidence[] = [];
    const fallbackHistory: ProviderFallbackRecord[] = [];
    for (const [adapterIndex, adapter] of this.adapters.entries()) {
      if (this.isCoolingDown(adapter)) {
        const provider = this.cooldowns.get(adapter)?.provider ?? "unknown";
        this.recordFallback({ fromProvider: provider, reason: "cooldown" }, fallbackHistory);
        continue;
      }

      let attempt = 1;
      while (attempt <= 2) {
        const attemptRequest = {
          ...request,
          invocationId: attempt === 1 ? request.invocationId : `${request.invocationId}:retry`,
          artifactDirectory: attempt === 1 ? request.artifactDirectory : `${request.artifactDirectory}/retry`,
        };
        let providerResult: ProviderRunResult;
        try {
          providerResult = await adapter.run(attemptRequest);
        } catch (error) {
          providerResult = adapterExceptionResult(attemptRequest, adapterIndex, error);
        }
        const result = providerResult.ok && !validResult(validateResult, providerResult)
          ? { ...providerResult, ok: false, failureClass: "invalid_output" as const }
          : providerResult;
        if (result.ok) {
          this.cooldowns.delete(adapter);
          this.persistence.saveCheckpoint({
            invocationId: request.invocationId,
            provider: result.identity.provider,
            threadId: result.threadId,
            selectedAdapterIndex: adapterIndex,
            attempt,
            result,
          });
          return {
            disposition: "succeeded",
            result,
            selectedAdapterIndex: adapterIndex,
            failures,
            fallbackHistory,
            recoveryCommand: null,
          };
        }

        const failureClass = result.failureClass ?? "unknown";
        const evidence: ProviderFailureEvidence = {
          provider: result.identity.provider,
          invocationId: request.invocationId,
          attempt,
          failureClass,
          exitCode: result.exitCode,
          retryAfterMs: retryAfterMilliseconds(result.stderr),
        };
        failures.push(evidence);
        this.persistence.saveFailure(evidence);
        this.noteFailure(adapter, result.identity.provider);

        if (failureClass === "auth") {
          return {
            disposition: "blocked", result, selectedAdapterIndex: null, failures, fallbackHistory,
            recoveryCommand: this.authRecoveryCommand,
          };
        }
        if (failureClass === "unknown") {
          return {
            disposition: "blocked", result, selectedAdapterIndex: null, failures, fallbackHistory,
            recoveryCommand: this.unknownRecoveryCommand,
          };
        }
        const retryable = failureClass === "transient" || failureClass === "rate_limit" || failureClass === "invalid_output";
        if (retryable && attempt === 1) {
          await this.sleep(evidence.retryAfterMs ?? this.backoffMs);
          attempt += 1;
          continue;
        }
        this.recordFallback({ fromProvider: result.identity.provider, reason: failureClass }, fallbackHistory);
        break;
      }
    }
    return {
      disposition: fallbackHistory.length > 0 ? "fallback" : "blocked",
      result: null,
      selectedAdapterIndex: null,
      failures,
      fallbackHistory,
      recoveryCommand: null,
    };
  }

  private recordFallback(record: ProviderFallbackRecord, history: ProviderFallbackRecord[]): void {
    history.push(record);
    this.persistence.saveFallback(record);
  }

  private noteFailure(adapter: ProviderAdapter, provider: string): void {
    const current = this.cooldowns.get(adapter) ?? { failures: 0, until: 0, provider };
    current.failures += 1;
    if (current.failures >= this.cooldownThreshold) current.until = this.now() + this.cooldownMs;
    this.cooldowns.set(adapter, current);
  }

  private isCoolingDown(adapter: ProviderAdapter): boolean {
    const state = this.cooldowns.get(adapter);
    if (!state) return false;
    if (state.until <= this.now()) {
      this.cooldowns.delete(adapter);
      return false;
    }
    return true;
  }
}

function validResult(validateResult: ProviderResultValidator, result: ProviderRunResult): boolean {
  try {
    return validateResult(result);
  } catch {
    return false;
  }
}

export function retryAfterMilliseconds(text: string): number | null {
  const match = text.match(/retry-after\s*:\s*(\d+)/iu);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

function adapterExceptionResult(
  request: ProviderRunRequest,
  adapterIndex: number,
  error: unknown,
): ProviderRunResult {
  const stderr = error instanceof Error ? error.message : String(error);
  const failureClass = classifyProviderFailure(stderr);
  return {
    invocationId: request.invocationId,
    ok: false,
    cancelled: false,
    identity: {
      provider: `adapter-${adapterIndex}`,
      model: null,
      executable: "unknown",
      version: null,
    },
    threadId: null,
    events: [],
    finalOutput: null,
    stderr,
    exitCode: null,
    signal: null,
    durationMs: 0,
    usage: null,
    failureClass,
    eventsPath: resolve(request.artifactDirectory, "events.jsonl"),
    finalOutputPath: resolve(request.artifactDirectory, "final.json"),
    stderrPath: resolve(request.artifactDirectory, "stderr.log"),
  };
}
