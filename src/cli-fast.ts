import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluationDataset } from "./evaluation/datasets.js";
import type { EvolutionConfiguration, EvolutionTarget } from "./evolution/proposals.js";

export async function runFastCli(argv: readonly string[]): Promise<void> {
  const parsed = parseInvocation(argv);
  if (parsed.command === "init") {
    if (parsed.rest.length > 0) throw new Error(`Unknown argument for init: ${parsed.rest[0]}`);
    return initialize(parsed.loopHome);
  }
  if (parsed.command === "config" && parsed.subcommand === "champion-init") {
    return initializeChampion(parsed.loopHome, parsed.rest);
  }
  if (parsed.command === "proposal" && parsed.subcommand === "create") {
    return createProposal(parsed.loopHome, parsed.rest);
  }
  if (parsed.command === "notify" && parsed.subcommand === "digest") {
    return enqueueDigest(parsed.loopHome, parsed.rest);
  }
  throw new Error("Fast CLI received an unsupported command");
}

async function initialize(loopHome: string): Promise<void> {
  const { SqliteStore } = await import("./store.js");
  mkdirSync(loopHome, { recursive: true });
  const store = new SqliteStore(resolve(loopHome, "state.sqlite"));
  store.close();
  print({ loopHome, initialized: true });
}

async function initializeChampion(loopHome: string, argv: readonly string[]): Promise<void> {
  const options = optionsFrom(argv, new Set(["project", "version", "config", "id"]));
  const project = requiredOption(options, "project");
  const version = options.version ?? "1";
  const [{ EvaluationStore }, proposals] = await Promise.all([
    import("./evaluation/store.js"),
    import("./evolution/proposals.js"),
  ]);
  mkdirSync(loopHome, { recursive: true });
  const store = new EvaluationStore(resolve(loopHome, "evaluation.sqlite"));
  try {
    if (store.activeChampion(project)) {
      throw new Error(`Project ${project} already has an active Champion; use proposal/config to evolve it`);
    }
    const configuration = options.config
      ? (parseObject(options.config) as unknown as EvolutionConfiguration)
      : proposals.defaultConfiguration();
    print(store.installConfigurationVariant(proposals.createInitialChampion({
      id: options.id ?? `champion:${project}:${version}`,
      projectScope: project,
      version,
      configuration,
    })));
  } finally {
    store.close();
  }
}

async function createProposal(loopHome: string, argv: readonly string[]): Promise<void> {
  const options = optionsFrom(argv, new Set([
    "id", "project", "target", "patch", "rationale", "source-facts", "minimum-samples", "dataset-dir",
  ]));
  const [{ SqliteStore }, { EvaluationStore }, { DatasetCatalog }, proposals] = await Promise.all([
    import("./store.js"),
    import("./evaluation/store.js"),
    import("./evaluation/datasets.js"),
    import("./evolution/proposals.js"),
  ]);
  const developmentPath = resolve(loopHome, "state.sqlite");
  if (!existsSync(developmentPath)) throw new Error(`No formal development state at ${developmentPath}`);
  const development = new SqliteStore(developmentPath, { readOnly: true });
  const store = new EvaluationStore(resolve(loopHome, "evaluation.sqlite"));
  try {
    const project = requiredOption(options, "project");
    const champion = store.activeChampion(project);
    if (!champion) throw new Error(`No active Champion for project ${project}`);
    const target = requiredOption(options, "target");
    if (!proposals.evolutionTargets.includes(target as EvolutionTarget)) {
      throw new Error(`Forbidden evolution target: ${target}`);
    }
    const datasets = DatasetCatalog.loadDirectory(resolve(options["dataset-dir"] ?? "eval")).list("proposal");
    assertNoHoldoutTasks(datasets, DatasetCatalog);
    print(store.installChangeProposal(proposals.createChangeProposal({
      id: requiredOption(options, "id"),
      projectScope: project,
      target: target as EvolutionTarget,
      baseChampion: champion,
      patch: parseObject(requiredOption(options, "patch")),
      rationale: requiredOption(options, "rationale"),
      sourceFactHashes: csv(requiredOption(options, "source-facts")),
      datasets,
      metrics: ["readySuccessRate", "doneSuccessRate", "verificationFailures"],
      minimumSamples: positiveInteger(options["minimum-samples"] ?? "5", "minimum samples"),
    })));
  } finally {
    store.close();
    development.close();
  }
}

async function enqueueDigest(loopHome: string, argv: readonly string[]): Promise<void> {
  const options = optionsFrom(argv, new Set(["period", "project"]));
  const period = options.period ?? "daily";
  if (period !== "daily" && period !== "weekly") throw new Error(`Unknown digest period: ${period}`);
  const [{ SqliteStore }, { EvaluationStore }, facts, metrics, digest] = await Promise.all([
    import("./store.js"),
    import("./evaluation/store.js"),
    import("./evaluation/facts.js"),
    import("./evaluation/metrics.js"),
    import("./evaluation/digest.js"),
  ]);
  const developmentPath = resolve(loopHome, "state.sqlite");
  if (!existsSync(developmentPath)) throw new Error(`No formal development state at ${developmentPath}`);
  const development = new SqliteStore(developmentPath, { readOnly: true });
  const evaluation = new EvaluationStore(resolve(loopHome, "evaluation.sqlite"));
  try {
    const now = new Date().toISOString();
    const window = digest.digestWindow(period, now);
    const runs = development.listRuns()
      .filter((run) => !options.project || run.binding?.projectAdapterName === options.project);
    const counts = digest.digestEventCounts(
      runs.flatMap((run) => development.listEvents(run.id)),
      window,
    );
    const selectedRunIds = new Set(counts.runIds);
    const projections = runs
      .filter((run) => selectedRunIds.has(run.id))
      .map((run) => metrics.projectRunMetrics(facts.exportRunFacts(development, run.id)));
    const rendered = digest.renderMetricsDigest(period, metrics.summarizeMetrics(projections), now, counts);
    print(evaluation.enqueueEvolutionOutbox(
      "metrics-digest",
      options.project ?? "all-projects",
      rendered,
      now,
      `${rendered.deduplicationKey}:${options.project ?? "all-projects"}`,
    ));
  } finally {
    evaluation.close();
    development.close();
  }
}

function parseInvocation(argv: readonly string[]): {
  loopHome: string;
  command: string;
  subcommand: string | null;
  rest: readonly string[];
} {
  let loopHome = resolve(process.env.LOOP_HOME ?? resolve(homedir(), ".agent-loop-harness"));
  const positional: Array<{ value: string; index: number }> = [];
  const consumed = new Set<number>();
  const globalValueOptions = new Set(["--loop-home", "--provider-profile", "--project-config"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (globalValueOptions.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      consumed.add(index);
      consumed.add(index + 1);
      if (argument === "--loop-home") loopHome = resolve(value);
      index += 1;
    } else if ([...globalValueOptions].some((name) => argument.startsWith(`${name}=`))) {
      const separator = argument.indexOf("=");
      const name = argument.slice(0, separator);
      const value = argument.slice(separator + 1);
      if (!value) throw new Error(`Missing value after ${name}`);
      consumed.add(index);
      if (name === "--loop-home") loopHome = resolve(value);
    } else if (!argument.startsWith("-") && positional.length < 2) {
      positional.push({ value: argument, index });
      consumed.add(index);
    }
  }
  const command = positional[0]?.value;
  if (!command) throw new Error("CLI command is required");
  const subcommand = command === "init" ? null : positional[1]?.value ?? null;
  return {
    loopHome,
    command,
    subcommand,
    rest: argv.filter((_value, index) => !consumed.has(index)),
  };
}

function optionsFrom(argv: readonly string[], allowed: ReadonlySet<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Invalid CLI option sequence near ${flag ?? "<end>"}`);
    }
    const separator = flag.indexOf("=");
    const name = flag.slice(2, separator < 0 ? undefined : separator);
    const value = separator < 0 ? argv[++index] : flag.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw new Error(`Missing value after --${name}`);
    }
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`);
    if (name in result) throw new Error(`Duplicate option: --${name}`);
    result[name] = value;
  }
  return result;
}

function requiredOption(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON value must be an object");
  }
  return parsed as Record<string, unknown>;
}

function csv(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("At least one value is required");
  return values;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function assertNoHoldoutTasks(
  datasets: readonly EvaluationDataset[],
  DatasetCatalog: typeof import("./evaluation/datasets.js").DatasetCatalog,
): void {
  const evalDirectory = fileURLToPath(new URL("../eval", import.meta.url));
  if (!existsSync(evalDirectory)) return;
  const holdoutKeys = new Set<string>();
  for (const dataset of DatasetCatalog.loadDirectory(evalDirectory).list("comparison")) {
    if (dataset.kind !== "holdout") continue;
    for (const task of dataset.tasks) {
      if (task.inputHash) holdoutKeys.add(`hash:${task.inputHash}`);
      holdoutKeys.add(`id:${task.id}`);
    }
  }
  for (const dataset of datasets) {
    for (const task of dataset.tasks) {
      if ((task.inputHash && holdoutKeys.has(`hash:${task.inputHash}`)) || holdoutKeys.has(`id:${task.id}`)) {
        throw new Error(
          `Dataset ${dataset.id} contains a Holdout Task (${task.id}); Holdout Tasks are inaccessible to proposal generation`,
        );
      }
    }
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
