import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { operationInputHash } from "../bindings.js";
import type { SanitizedFactBundle } from "./facts.js";

export const datasetKinds = ["historical", "golden", "holdout", "failure-injection"] as const;
export type DatasetKind = (typeof datasetKinds)[number];
export type DatasetPurpose = "proposal" | "comparison" | "readiness";

export interface EvaluationTask {
  id: string;
  projectScope: string;
  inputHash: string;
  expected: {
    ready?: boolean;
    done?: boolean;
    providerFailureClass?: string;
    findingOutcomes?: Record<string, "confirmed" | "rejected">;
  };
  sourceRunId?: string;
  sourceFactHash?: string;
}

export interface EvaluationDataset {
  schemaVersion: 1;
  id: string;
  kind: DatasetKind;
  dataSource: "real" | "fixture";
  version: string;
  tasks: EvaluationTask[];
  contentHash: string;
}

type DatasetDocument = Omit<EvaluationDataset, "contentHash">;

export class DatasetCatalog {
  private readonly datasets = new Map<string, EvaluationDataset>();

  static loadDirectory(directory: string): DatasetCatalog {
    const catalog = new DatasetCatalog();
    for (const name of readdirSync(resolve(directory)).filter((item) => extname(item) === ".json").sort()) {
      const document = JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown;
      catalog.install(parseDataset(document));
    }
    return catalog;
  }

  install(dataset: EvaluationDataset): EvaluationDataset {
    const existing = this.datasets.get(dataset.id);
    if (existing && existing.contentHash !== dataset.contentHash) {
      throw new Error(`Dataset ${dataset.id} is immutable within a catalog`);
    }
    this.datasets.set(dataset.id, dataset);
    return dataset;
  }

  get(id: string, purpose: DatasetPurpose): EvaluationDataset {
    const dataset = this.datasets.get(id);
    if (!dataset) throw new Error(`Evaluation Dataset not found: ${id}`);
    if (purpose === "proposal" && dataset.kind === "holdout") {
      throw new Error("Holdout Tasks are inaccessible to proposal generation");
    }
    return dataset;
  }

  list(purpose: DatasetPurpose): EvaluationDataset[] {
    return [...this.datasets.values()]
      .filter((dataset) => purpose !== "proposal" || dataset.kind !== "holdout")
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function parseDataset(value: unknown): EvaluationDataset {
  if (!isRecord(value) || value.schemaVersion !== 1 || !text(value.id) || !text(value.version) ||
      !datasetKinds.includes(value.kind as DatasetKind) || !Array.isArray(value.tasks)) {
    throw new Error("Invalid Evaluation Dataset document");
  }
  const tasks = value.tasks.map(parseTask);
  const document: DatasetDocument = {
    schemaVersion: 1,
    id: value.id as string,
    kind: value.kind as DatasetKind,
    dataSource: value.dataSource === "real" ? "real" : "fixture",
    version: value.version as string,
    tasks,
  };
  return { ...document, contentHash: operationInputHash(document) };
}

export function historicalDataset(id: string, facts: readonly SanitizedFactBundle[]): EvaluationDataset {
  const document: DatasetDocument = {
    schemaVersion: 1,
    id,
    kind: "historical",
    dataSource: "real",
    version: "1",
    tasks: facts.map((fact) => ({
      id: `historical:${fact.run.id}:${fact.factHash.slice(0, 12)}`,
      projectScope: fact.run.binding?.projectAdapterName ?? "unbound",
      inputHash: fact.factHash,
      expected: {
        ready: fact.run.status === "ready" || fact.run.status === "merged" || fact.run.status === "done",
        done: fact.run.status === "done",
        findingOutcomes: Object.fromEntries(fact.reviewerFindings
          .filter((finding) => finding.outcome === "confirmed" || finding.outcome === "rejected")
          .map((finding) => [finding.id, finding.outcome as "confirmed" | "rejected"])),
      },
      sourceRunId: fact.run.id,
      sourceFactHash: fact.factHash,
    })),
  };
  return { ...document, contentHash: operationInputHash(document) };
}

function parseTask(value: unknown): EvaluationTask {
  if (!isRecord(value) || !text(value.id) || !text(value.projectScope) || !text(value.inputHash) ||
      !isRecord(value.expected)) throw new Error("Invalid Evaluation Task");
  const expected = value.expected;
  if ((expected.ready !== undefined && typeof expected.ready !== "boolean") ||
      (expected.done !== undefined && typeof expected.done !== "boolean") ||
      (expected.providerFailureClass !== undefined && typeof expected.providerFailureClass !== "string") ||
      (expected.findingOutcomes !== undefined && !validFindingOutcomes(expected.findingOutcomes))) {
    throw new Error(`Invalid expected result for Evaluation Task ${value.id as string}`);
  }
  return {
    id: value.id as string,
    projectScope: value.projectScope as string,
    inputHash: value.inputHash as string,
    expected: expected as EvaluationTask["expected"],
    ...(text(value.sourceRunId) ? { sourceRunId: value.sourceRunId as string } : {}),
    ...(text(value.sourceFactHash) ? { sourceFactHash: value.sourceFactHash as string } : {}),
  };
}

function validFindingOutcomes(value: unknown): value is Record<string, "confirmed" | "rejected"> {
  return isRecord(value) && Object.values(value).every((item) => item === "confirmed" || item === "rejected");
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
