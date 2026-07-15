import Database from "better-sqlite3";
import { canonicalJson } from "../bindings.js";
import type { SanitizedFactBundle } from "./facts.js";
import type { RunMetricsProjection } from "./metrics.js";
import type { ReadinessReport } from "./readiness.js";
import type { EvaluationDataset } from "./datasets.js";
import type { EvaluationRun } from "./replay.js";

type Sqlite = InstanceType<typeof Database>;

export class EvaluationStore {
  readonly database: Sqlite;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  installFactBundle(bundle: SanitizedFactBundle): SanitizedFactBundle {
    const existing = this.getFactBundle(bundle.run.id, bundle.factHash);
    if (existing) {
      if (canonicalJson(stableBundle(existing)) !== canonicalJson(stableBundle(bundle))) {
        throw new Error(`Fact Bundle ${bundle.run.id}/${bundle.factHash} is immutable`);
      }
      return existing;
    }
    this.database.prepare(
      "INSERT INTO fact_bundles (run_id, fact_hash, source, bundle_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(bundle.run.id, bundle.factHash, bundle.source, JSON.stringify(bundle), bundle.exportedAt);
    return this.getFactBundle(bundle.run.id, bundle.factHash)!;
  }

  getFactBundle(runId: string, factHash: string): SanitizedFactBundle | null {
    const row = this.database.prepare(
      "SELECT bundle_json FROM fact_bundles WHERE run_id = ? AND fact_hash = ?",
    ).get(runId, factHash) as { bundle_json: string } | undefined;
    return row ? JSON.parse(row.bundle_json) as SanitizedFactBundle : null;
  }

  listLatestFactBundles(): SanitizedFactBundle[] {
    const rows = this.database.prepare(
      `SELECT bundle_json FROM fact_bundles AS current
       WHERE created_at = (SELECT MAX(created_at) FROM fact_bundles WHERE run_id = current.run_id)
       ORDER BY run_id`,
    ).all() as Array<{ bundle_json: string }>;
    return rows.map((row) => JSON.parse(row.bundle_json) as SanitizedFactBundle);
  }

  installMetrics(metrics: RunMetricsProjection, factHash: string, createdAt = new Date().toISOString()): void {
    const serialized = JSON.stringify(metrics);
    const existing = this.database.prepare(
      "SELECT metrics_json FROM metric_projections WHERE run_id = ? AND fact_hash = ?",
    ).get(metrics.runId, factHash) as { metrics_json: string } | undefined;
    if (existing && canonicalJson(JSON.parse(existing.metrics_json)) !== canonicalJson(metrics)) {
      throw new Error(`Metric projection ${metrics.runId}/${factHash} is immutable`);
    }
    if (!existing) this.database.prepare(
      "INSERT INTO metric_projections (run_id, fact_hash, metrics_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(metrics.runId, factHash, serialized, createdAt);
  }

  getMetrics(runId: string, factHash: string): RunMetricsProjection | null {
    const row = this.database.prepare(
      "SELECT metrics_json FROM metric_projections WHERE run_id = ? AND fact_hash = ?",
    ).get(runId, factHash) as { metrics_json: string } | undefined;
    return row ? JSON.parse(row.metrics_json) as RunMetricsProjection : null;
  }

  recordReadiness(report: ReadinessReport, createdAt = new Date().toISOString()): number {
    const result = this.database.prepare(
      "INSERT INTO readiness_snapshots (report_json, created_at) VALUES (?, ?)",
    ).run(JSON.stringify(report), createdAt);
    return Number(result.lastInsertRowid);
  }

  latestReadiness(): ReadinessReport | null {
    const row = this.database.prepare(
      "SELECT report_json FROM readiness_snapshots ORDER BY id DESC LIMIT 1",
    ).get() as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as ReadinessReport : null;
  }

  installDataset(dataset: EvaluationDataset, createdAt = new Date().toISOString()): EvaluationDataset {
    const existing = this.getDataset(dataset.id);
    if (existing) {
      if (existing.contentHash !== dataset.contentHash || canonicalJson(existing) !== canonicalJson(dataset)) {
        throw new Error(`Evaluation Dataset ${dataset.id} is immutable`);
      }
      return existing;
    }
    this.database.prepare(
      "INSERT INTO evaluation_datasets (id, kind, version, content_hash, dataset_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(dataset.id, dataset.kind, dataset.version, dataset.contentHash, JSON.stringify(dataset), createdAt);
    return this.getDataset(dataset.id)!;
  }

  getDataset(id: string): EvaluationDataset | null {
    const row = this.database.prepare("SELECT dataset_json FROM evaluation_datasets WHERE id = ?")
      .get(id) as { dataset_json: string } | undefined;
    return row ? JSON.parse(row.dataset_json) as EvaluationDataset : null;
  }

  listDatasets(): EvaluationDataset[] {
    return (this.database.prepare("SELECT dataset_json FROM evaluation_datasets ORDER BY id").all() as
      Array<{ dataset_json: string }>).map((row) => JSON.parse(row.dataset_json) as EvaluationDataset);
  }

  installEvaluationRun(run: EvaluationRun): EvaluationRun {
    const existing = this.getEvaluationRun(run.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(run)) throw new Error(`Evaluation Run ${run.id} is immutable`);
      return existing;
    }
    this.database.prepare(
      `INSERT INTO evaluation_runs
       (id, source_run_id, source_fact_hash, mode, replayability, status, run_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run.id, run.sourceRunId, run.sourceFactHash, run.mode, run.replayability,
      run.status, JSON.stringify(run), run.createdAt);
    return this.getEvaluationRun(run.id)!;
  }

  getEvaluationRun(id: string): EvaluationRun | null {
    const row = this.database.prepare("SELECT run_json FROM evaluation_runs WHERE id = ?")
      .get(id) as { run_json: string } | undefined;
    return row ? JSON.parse(row.run_json) as EvaluationRun : null;
  }

  listEvaluationRuns(): EvaluationRun[] {
    return (this.database.prepare("SELECT run_json FROM evaluation_runs ORDER BY created_at, id").all() as
      Array<{ run_json: string }>).map((row) => JSON.parse(row.run_json) as EvaluationRun);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS fact_bundles (
        run_id TEXT NOT NULL,
        fact_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('real', 'fixture')),
        bundle_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, fact_hash)
      );
      CREATE TABLE IF NOT EXISTS metric_projections (
        run_id TEXT NOT NULL,
        fact_hash TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, fact_hash),
        FOREIGN KEY(run_id, fact_hash) REFERENCES fact_bundles(run_id, fact_hash)
      );
      CREATE TABLE IF NOT EXISTS readiness_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_datasets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('historical', 'golden', 'holdout', 'failure-injection')),
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dataset_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        source_fact_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('full', 'verify-only')),
        replayability TEXT NOT NULL CHECK(replayability IN ('exact', 'verify-only', 'partial', 'none')),
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'not-replayable')),
        run_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(source_run_id, source_fact_hash) REFERENCES fact_bundles(run_id, fact_hash)
      );
    `);
  }
}

function stableBundle(bundle: SanitizedFactBundle): Omit<SanitizedFactBundle, "exportedAt"> {
  const { exportedAt: _exportedAt, ...stable } = bundle;
  return stable;
}
