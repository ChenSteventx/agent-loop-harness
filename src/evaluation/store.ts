import Database from "better-sqlite3";
import { canonicalJson } from "../bindings.js";
import type { SanitizedFactBundle } from "./facts.js";
import type { RunMetricsProjection } from "./metrics.js";
import type { ReadinessReport } from "./readiness.js";
import type { EvaluationDataset } from "./datasets.js";
import type { EvaluationRun } from "./replay.js";
import type { CandidateMemory, CandidateMemoryStatus } from "../memory/candidates.js";
import type {
  ChangeProposal,
  ConfigurationVariant,
  PromotionDecision,
  RollbackDecision,
} from "../evolution/proposals.js";
import type { OfflineComparison, ShadowEvaluation } from "./compare.js";

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

  installCandidateMemory(memory: CandidateMemory): CandidateMemory {
    const existing = this.getCandidateMemory(memory.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(memory)) throw new Error(`Candidate Memory ${memory.id} is immutable`);
      return existing;
    }
    const duplicate = this.database.prepare(
      "SELECT id FROM candidate_memories WHERE project_scope = ? AND content_hash = ?",
    ).get(memory.projectScope, memory.contentHash) as { id: string } | undefined;
    if (duplicate) throw new Error(`Candidate Memory duplicates ${duplicate.id}`);
    if (memory.status !== "candidate" || memory.decision !== null) {
      throw new Error("Candidate Memory must be installed before any decision");
    }
    this.database.prepare(
      `INSERT INTO candidate_memories
       (id, project_scope, kind, content_hash, status, memory_json, created_at, expires_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(memory.id, memory.projectScope, memory.kind, memory.contentHash, memory.status,
      JSON.stringify(memory), memory.createdAt, memory.expiresAt);
    return this.getCandidateMemory(memory.id)!;
  }

  getCandidateMemory(id: string): CandidateMemory | null {
    const row = this.database.prepare("SELECT memory_json FROM candidate_memories WHERE id = ?")
      .get(id) as { memory_json: string } | undefined;
    return row ? JSON.parse(row.memory_json) as CandidateMemory : null;
  }

  listCandidateMemories(projectScope?: string): CandidateMemory[] {
    const rows = (projectScope
      ? this.database.prepare("SELECT memory_json FROM candidate_memories WHERE project_scope = ? ORDER BY id").all(projectScope)
      : this.database.prepare("SELECT memory_json FROM candidate_memories ORDER BY project_scope, id").all()) as
      Array<{ memory_json: string }>;
    return rows.map((row) => JSON.parse(row.memory_json) as CandidateMemory);
  }

  decideCandidateMemory(input: {
    id: string;
    status: Exclude<CandidateMemoryStatus, "candidate">;
    authority: "human" | "system-expiry";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  }): CandidateMemory {
    const current = this.getCandidateMemory(input.id);
    if (!current) throw new Error(`Candidate Memory not found: ${input.id}`);
    const decision = { status: input.status, authority: input.authority, decidedBy: input.decidedBy,
      reason: input.reason, decidedAt: input.decidedAt };
    if (current.status === input.status && canonicalJson(current.decision) === canonicalJson(decision)) return current;
    validateMemoryDecision(current, input);
    const updated: CandidateMemory = { ...current, status: input.status, decision };
    this.database.prepare(
      "UPDATE candidate_memories SET status = ?, memory_json = ?, decided_at = ? WHERE id = ?",
    ).run(updated.status, JSON.stringify(updated), input.decidedAt, input.id);
    return this.getCandidateMemory(input.id)!;
  }

  installChangeProposal(proposal: ChangeProposal): ChangeProposal {
    const existing = this.getChangeProposal(proposal.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(proposal)) throw new Error(`Change Proposal ${proposal.id} is immutable`);
      return existing;
    }
    if (proposal.status !== "draft" || proposal.approval !== null) throw new Error("Change Proposal must begin as draft");
    this.database.prepare(
      `INSERT INTO change_proposals
       (id, project_scope, target, base_champion_id, proposal_hash, status, proposal_json, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(proposal.id, proposal.projectScope, proposal.target, proposal.baseChampionId,
      proposal.proposalHash, proposal.status, JSON.stringify(proposal), proposal.createdAt);
    return this.getChangeProposal(proposal.id)!;
  }

  getChangeProposal(id: string): ChangeProposal | null {
    const row = this.database.prepare("SELECT proposal_json FROM change_proposals WHERE id = ?")
      .get(id) as { proposal_json: string } | undefined;
    return row ? JSON.parse(row.proposal_json) as ChangeProposal : null;
  }

  listChangeProposals(projectScope?: string): ChangeProposal[] {
    const rows = (projectScope
      ? this.database.prepare("SELECT proposal_json FROM change_proposals WHERE project_scope = ? ORDER BY created_at, id").all(projectScope)
      : this.database.prepare("SELECT proposal_json FROM change_proposals ORDER BY project_scope, created_at, id").all()) as
      Array<{ proposal_json: string }>;
    return rows.map((row) => JSON.parse(row.proposal_json) as ChangeProposal);
  }

  decideChangeProposal(input: {
    id: string;
    status: "approved" | "rejected" | "evaluated";
    authority: "human";
    decidedBy: string;
    reason: string;
    decidedAt: string;
  }): ChangeProposal {
    const current = this.getChangeProposal(input.id);
    if (!current) throw new Error(`Change Proposal not found: ${input.id}`);
    if (input.authority !== "human" || !input.decidedBy.trim() || !input.reason.trim()) {
      throw new Error("Proposal decision requires explicit human authority, actor, and reason");
    }
    const allowed = current.status === "draft"
      ? ["approved", "rejected"]
      : current.status === "approved"
        ? ["evaluated"]
        : [];
    if (!allowed.includes(input.status)) throw new Error(`Illegal Change Proposal decision: ${current.status} -> ${input.status}`);
    const approval = current.approval ?? {
      authority: "human" as const,
      decidedBy: input.decidedBy,
      reason: input.reason,
      decidedAt: input.decidedAt,
    };
    const updated: ChangeProposal = { ...current, status: input.status, approval };
    this.database.prepare(
      "UPDATE change_proposals SET status = ?, proposal_json = ?, decided_at = ? WHERE id = ?",
    ).run(updated.status, JSON.stringify(updated), input.decidedAt, input.id);
    return this.getChangeProposal(input.id)!;
  }

  installConfigurationVariant(variant: ConfigurationVariant): ConfigurationVariant {
    const existing = this.getConfigurationVariant(variant.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(variant)) throw new Error(`Configuration Variant ${variant.id} is immutable`);
      return existing;
    }
    if (variant.status === "champion" && this.activeChampion(variant.projectScope)) {
      throw new Error(`Project ${variant.projectScope} already has an active Champion`);
    }
    if (variant.status === "challenger" && (!variant.proposalId || !this.getChangeProposal(variant.proposalId))) {
      throw new Error("Challenger requires a persisted Change Proposal");
    }
    this.database.prepare(
      `INSERT INTO configuration_variants
       (id, project_scope, proposal_id, version, configuration_hash, status, variant_json, created_at, activated_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(variant.id, variant.projectScope, variant.proposalId, variant.version, variant.configurationHash,
      variant.status, JSON.stringify(variant), variant.createdAt, variant.activatedAt, variant.retiredAt);
    return this.getConfigurationVariant(variant.id)!;
  }

  getConfigurationVariant(id: string): ConfigurationVariant | null {
    const row = this.database.prepare("SELECT variant_json FROM configuration_variants WHERE id = ?")
      .get(id) as { variant_json: string } | undefined;
    return row ? JSON.parse(row.variant_json) as ConfigurationVariant : null;
  }

  listConfigurationVariants(projectScope?: string): ConfigurationVariant[] {
    const rows = (projectScope
      ? this.database.prepare("SELECT variant_json FROM configuration_variants WHERE project_scope = ? ORDER BY created_at, id").all(projectScope)
      : this.database.prepare("SELECT variant_json FROM configuration_variants ORDER BY project_scope, created_at, id").all()) as
      Array<{ variant_json: string }>;
    return rows.map((row) => JSON.parse(row.variant_json) as ConfigurationVariant);
  }

  activeChampion(projectScope: string): ConfigurationVariant | null {
    const row = this.database.prepare(
      "SELECT variant_json FROM configuration_variants WHERE project_scope = ? AND status = 'champion'",
    ).get(projectScope) as { variant_json: string } | undefined;
    return row ? JSON.parse(row.variant_json) as ConfigurationVariant : null;
  }

  activateChallenger(decision: PromotionDecision): ConfigurationVariant {
    const transaction = this.database.transaction(() => {
      const champion = this.activeChampion(decision.projectScope);
      const challenger = this.getConfigurationVariant(decision.challengerId);
      const proposal = this.getChangeProposal(decision.proposalId);
      if (!champion || champion.id !== decision.fromChampionId || !challenger || challenger.status !== "challenger" ||
          challenger.projectScope !== decision.projectScope || !proposal || proposal.status !== "evaluated" ||
          decision.verdict !== "promote" || decision.authority !== "human") {
        throw new Error("Promotion Decision does not match persisted evolution facts");
      }
      const retired: ConfigurationVariant = { ...champion, status: "retired", retiredAt: decision.decidedAt };
      const activated: ConfigurationVariant = { ...challenger, status: "champion", activatedAt: decision.decidedAt };
      this.writeVariant(retired);
      this.writeVariant(activated);
      const promoted: ChangeProposal = { ...proposal, status: "promoted" };
      this.database.prepare("UPDATE change_proposals SET status = ?, proposal_json = ? WHERE id = ?")
        .run(promoted.status, JSON.stringify(promoted), promoted.id);
      this.insertEvolutionDecision(decision.id, decision.projectScope, "promotion", decision, decision.decidedAt);
      return this.getConfigurationVariant(activated.id)!;
    });
    return transaction();
  }

  rollbackChampion(decision: RollbackDecision): ConfigurationVariant {
    const transaction = this.database.transaction(() => {
      const champion = this.activeChampion(decision.projectScope);
      const restore = this.getConfigurationVariant(decision.restoreChampionId);
      if (!champion || champion.id !== decision.fromChampionId || !restore || restore.projectScope !== decision.projectScope ||
          restore.status !== "retired" || champion.id === restore.id) {
        throw new Error("Rollback Decision does not match current and restorable Champions");
      }
      const rolledBack: ConfigurationVariant = { ...champion, status: "rolled-back", retiredAt: decision.decidedAt };
      const restored: ConfigurationVariant = { ...restore, status: "champion", activatedAt: decision.decidedAt, retiredAt: null };
      this.writeVariant(rolledBack);
      this.writeVariant(restored);
      if (champion.proposalId) {
        const proposal = this.getChangeProposal(champion.proposalId);
        if (proposal) {
          const updated: ChangeProposal = { ...proposal, status: "rolled-back" };
          this.database.prepare("UPDATE change_proposals SET status = ?, proposal_json = ? WHERE id = ?")
            .run(updated.status, JSON.stringify(updated), updated.id);
        }
      }
      this.insertEvolutionDecision(decision.id, decision.projectScope, "rollback", decision, decision.decidedAt);
      return this.getConfigurationVariant(restored.id)!;
    });
    return transaction();
  }

  installOfflineComparison(comparison: OfflineComparison): OfflineComparison {
    const existing = this.getOfflineComparison(comparison.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(comparison)) throw new Error(`Offline Comparison ${comparison.id} is immutable`);
      return existing;
    }
    this.database.prepare(
      `INSERT INTO offline_comparisons
       (id, project_scope, proposal_id, champion_id, challenger_id, status, comparison_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(comparison.id, comparison.projectScope, comparison.proposalId, comparison.championId,
      comparison.challengerId, comparison.status, JSON.stringify(comparison), comparison.createdAt);
    return this.getOfflineComparison(comparison.id)!;
  }

  getOfflineComparison(id: string): OfflineComparison | null {
    const row = this.database.prepare("SELECT comparison_json FROM offline_comparisons WHERE id = ?")
      .get(id) as { comparison_json: string } | undefined;
    return row ? JSON.parse(row.comparison_json) as OfflineComparison : null;
  }

  listOfflineComparisons(projectScope?: string): OfflineComparison[] {
    const rows = (projectScope
      ? this.database.prepare("SELECT comparison_json FROM offline_comparisons WHERE project_scope = ? ORDER BY created_at, id").all(projectScope)
      : this.database.prepare("SELECT comparison_json FROM offline_comparisons ORDER BY project_scope, created_at, id").all()) as
      Array<{ comparison_json: string }>;
    return rows.map((row) => JSON.parse(row.comparison_json) as OfflineComparison);
  }

  installShadowEvaluation(shadow: ShadowEvaluation): ShadowEvaluation {
    const existing = this.getShadowEvaluation(shadow.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(shadow)) throw new Error(`Shadow Evaluation ${shadow.id} is immutable`);
      return existing;
    }
    if (shadow.authoritative !== false || shadow.providerRoutingChanged !== false || shadow.runStateChanged !== false) {
      throw new Error("Shadow Evaluation must be non-authoritative");
    }
    this.database.prepare(
      `INSERT INTO shadow_evaluations
       (id, source_run_id, source_fact_hash, project_scope, champion_id, challenger_id, agrees, shadow_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(shadow.id, shadow.sourceRunId, shadow.sourceFactHash, shadow.projectScope,
      shadow.championId, shadow.challengerId, shadow.agrees ? 1 : 0, JSON.stringify(shadow), shadow.createdAt);
    return this.getShadowEvaluation(shadow.id)!;
  }

  getShadowEvaluation(id: string): ShadowEvaluation | null {
    const row = this.database.prepare("SELECT shadow_json FROM shadow_evaluations WHERE id = ?")
      .get(id) as { shadow_json: string } | undefined;
    return row ? JSON.parse(row.shadow_json) as ShadowEvaluation : null;
  }

  listShadowEvaluations(projectScope?: string): ShadowEvaluation[] {
    const rows = (projectScope
      ? this.database.prepare("SELECT shadow_json FROM shadow_evaluations WHERE project_scope = ? ORDER BY created_at, id").all(projectScope)
      : this.database.prepare("SELECT shadow_json FROM shadow_evaluations ORDER BY project_scope, created_at, id").all()) as
      Array<{ shadow_json: string }>;
    return rows.map((row) => JSON.parse(row.shadow_json) as ShadowEvaluation);
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
      CREATE TABLE IF NOT EXISTS candidate_memories (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('failure-pattern', 'finding-rule', 'provider-observation')),
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'approved', 'rejected', 'superseded', 'expired')),
        memory_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(project_scope, content_hash)
      );
      CREATE TABLE IF NOT EXISTS change_proposals (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        target TEXT NOT NULL,
        base_champion_id TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'rejected', 'evaluated', 'promoted', 'rolled-back')),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS configuration_variants (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        proposal_id TEXT REFERENCES change_proposals(id),
        version TEXT NOT NULL,
        configuration_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('champion', 'challenger', 'retired', 'rolled-back')),
        variant_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        retired_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_champion_per_project
        ON configuration_variants(project_scope) WHERE status = 'champion';
      CREATE TABLE IF NOT EXISTS evolution_decisions (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('promotion', 'rollback')),
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offline_comparisons (
        id TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES change_proposals(id),
        champion_id TEXT NOT NULL REFERENCES configuration_variants(id),
        challenger_id TEXT NOT NULL REFERENCES configuration_variants(id),
        status TEXT NOT NULL CHECK(status IN ('completed', 'insufficient-samples', 'guardrail-failed')),
        comparison_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_evaluations (
        id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        source_fact_hash TEXT NOT NULL,
        project_scope TEXT NOT NULL,
        champion_id TEXT NOT NULL REFERENCES configuration_variants(id),
        challenger_id TEXT NOT NULL REFERENCES configuration_variants(id),
        agrees INTEGER NOT NULL CHECK(agrees IN (0, 1)),
        shadow_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(source_run_id, source_fact_hash) REFERENCES fact_bundles(run_id, fact_hash)
      );
    `);
  }

  private writeVariant(variant: ConfigurationVariant): void {
    this.database.prepare(
      "UPDATE configuration_variants SET status = ?, variant_json = ?, activated_at = ?, retired_at = ? WHERE id = ?",
    ).run(variant.status, JSON.stringify(variant), variant.activatedAt, variant.retiredAt, variant.id);
  }

  private insertEvolutionDecision(
    id: string,
    projectScope: string,
    kind: "promotion" | "rollback",
    decision: PromotionDecision | RollbackDecision,
    createdAt: string,
  ): void {
    this.database.prepare(
      "INSERT INTO evolution_decisions (id, project_scope, kind, decision_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, projectScope, kind, JSON.stringify(decision), createdAt);
  }
}

function validateMemoryDecision(
  current: CandidateMemory,
  input: {
    status: Exclude<CandidateMemoryStatus, "candidate">;
    authority: "human" | "system-expiry";
    decidedBy: string;
    reason: string;
  },
): void {
  if (!input.decidedBy.trim() || !input.reason.trim()) throw new Error("Memory decision requires actor and reason");
  if (input.status === "expired" && input.authority !== "system-expiry") {
    throw new Error("Only the deterministic expiry mechanism can expire Candidate Memory");
  }
  if (input.status !== "expired" && input.authority !== "human") {
    throw new Error("Only a human decision can approve, reject, or supersede Candidate Memory");
  }
  const allowed = current.status === "candidate"
    ? ["approved", "rejected", "expired"]
    : current.status === "approved"
      ? ["rejected", "superseded", "expired"]
      : [];
  if (!allowed.includes(input.status)) throw new Error(`Illegal Candidate Memory decision: ${current.status} -> ${input.status}`);
}

function stableBundle(bundle: SanitizedFactBundle): Omit<SanitizedFactBundle, "exportedAt"> {
  const { exportedAt: _exportedAt, ...stable } = bundle;
  return stable;
}
