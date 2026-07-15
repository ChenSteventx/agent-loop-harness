import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunBinding } from "../src/domain.js";
import {
  createInvocationManifest,
  gradeReplayability,
  manifestContainsSensitiveMaterial,
} from "../src/evaluation/manifests.js";
import { SqliteStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

const binding: RunBinding = {
  version: 1,
  taskSpecPath: "/project/task.yaml",
  taskSpec: {
    id: "MANIFEST-1",
    goal: "record replay inputs",
    acceptance: ["the manifest is immutable"],
    risk: "low",
    verification: [{ id: "check", argv: ["npm", "test"] }],
  },
  taskSpecHash: "task-hash",
  acceptanceHash: "acceptance-hash",
  baselineCommit: "baseline",
  sourceRepository: "/project",
  worktreePath: "/project-worktree",
  risk: "low",
  executionTemplate: "solo",
  providerProfile: "CODEX_PRIMARY",
  projectAdapterName: "generic-node",
  policyVersion: "generic-node/v2",
};

function manifest() {
  return createInvocationManifest({
    id: "run-1:author:manifest:v1",
    runId: "run-1",
    operationId: "run-1:author",
    role: "author",
    binding,
    renderedPrompt: "Use short-lived credential TOP-SECRET-TOKEN without printing it",
    outputSchemaPath: resolve("schemas/author-output.schema.json"),
    configuredProvider: { provider: "Codex CLI", model: "configured-model" },
    actualProvider: {
      provider: "openai-codex",
      model: "actual-model",
      modelFamily: "gpt",
      executable: "codex",
      version: "0.1.0",
    },
    currentCommit: "candidate",
    verificationPlan: binding.taskSpec.verification,
    context: [{ kind: "task", reference: "task.yaml", content: binding.taskSpec, trust: "project" }],
    createdAt: "2026-07-15T00:00:00.000Z",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Invocation Manifest and replayability", () => {
  it("records hashes and observed Provider identity without persisting prompt text or environment variables", () => {
    const value = manifest();
    const serialized = JSON.stringify(value);

    expect(value).toMatchObject({
      schemaVersion: 1,
      role: "author",
      provider: {
        configuredProvider: "Codex CLI",
        configuredModel: "configured-model",
        actualProvider: "openai-codex",
        actualModel: "actual-model",
        actualFamily: "gpt",
        adapterVersion: "0.1.0",
      },
      prompt: { redactedArtifactPath: null },
      inputs: { verificationPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(serialized).not.toContain("TOP-SECRET-TOKEN");
    expect(serialized).not.toContain("process.env");
    expect(manifestContainsSensitiveMaterial(value)).toBe(false);
  });

  it("stores one immutable Manifest per operation", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-loop-manifest-"));
    temporaryDirectories.push(directory);
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createBoundRun("run-1", binding.taskSpec.id, binding, "2026-07-15T00:00:00.000Z");
    store.createOperation({
      id: "run-1:author",
      runId: "run-1",
      kind: "author",
      idempotencyKey: "run-1:author",
      input: { role: "author" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const value = manifest();

    expect(store.installInvocationManifest(value)).toEqual(value);
    expect(store.installInvocationManifest(value)).toEqual(value);
    expect(store.listInvocationManifests("run-1")).toEqual([value]);
    expect(() => store.installInvocationManifest({
      ...value,
      provider: { ...value.provider, actualProvider: "different" },
    })).toThrow("immutable");
    store.close();
  });

  it("never calls a historical Run exact when its Invocation Manifest is missing", () => {
    expect(gradeReplayability({ binding, manifests: [], requiredOperationIds: ["run-1:author"] })).toEqual({
      grade: "verify-only",
      missingInputs: [
        "invocation_manifests",
        "prompt_hashes",
        "provider_identity",
        "context_manifest",
        "environment_fingerprint",
      ],
    });
    expect(gradeReplayability({
      binding,
      manifests: [manifest()],
      requiredOperationIds: ["run-1:author"],
    })).toEqual({ grade: "exact", missingInputs: [] });
    expect(gradeReplayability({ binding: null, manifests: [] })).toEqual({
      grade: "none",
      missingInputs: ["run_binding"],
    });
    const incomplete = manifest();
    incomplete.provider.actualModel = null;
    expect(gradeReplayability({ binding, manifests: [incomplete] })).toEqual({
      grade: "verify-only",
      missingInputs: [`provider_model:${incomplete.id}`],
    });
  });
});
