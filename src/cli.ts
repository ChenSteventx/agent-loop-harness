#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { Orchestrator, defaultLoopHome } from "./orchestrator.js";
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  PiAdapter,
  type ProviderAdapter,
  type ProviderRunRequest,
  type ProviderRunResult,
} from "./provider.js";
import { GenericNodeProjectAdapter } from "./project.js";
import { defaultRoleOutputSchemas } from "./role-output-schemas.js";
import {
  createProviderProfile,
  providerProfileNames,
  type ProviderProfileName,
} from "./profiles.js";

const program = new Command()
  .name("agent-loop")
  .description("Evidence-driven bounded coding loop")
  .option("--loop-home <path>", "external state directory", process.env.LOOP_HOME ?? defaultLoopHome())
  .option(
    "--provider-profile <name>",
    "fixed Provider profile: CODEX_PRIMARY or CLAUDE_PRIMARY",
    process.env.AGENT_LOOP_PROVIDER_PROFILE ?? "CODEX_PRIMARY",
  );

program
  .command("init")
  .description("initialize the private loop state directory")
  .action(() => {
    const home = resolve(program.opts<{ loopHome: string }>().loopHome);
    mkdirSync(home, { recursive: true });
    const orchestrator = createOrchestrator(home);
    orchestrator.close();
    print({ loopHome: home, initialized: true });
  });

program
  .command("run")
  .requiredOption("--task <path>")
  .requiredOption("--repository <path>")
  .option("--run-id <id>")
  .description("create a worktree and execute the fixed risk-routed proof loop")
  .action(async (options: { task: string; repository: string; runId?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(
        await orchestrator.start({
          runId: options.runId ?? randomUUID(),
          taskPath: resolve(options.task),
          targetRepository: resolve(options.repository),
        }),
      ),
    );
  });

program
  .command("status")
  .option("--run-id <id>")
  .description("show durable run state after completion or interruption")
  .action(async (options: { runId?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(options.runId ? orchestrator.status(options.runId) : orchestrator.listRuns()),
    );
  });

program
  .command("resume")
  .requiredOption("--run-id <id>")
  .option("--task <path>", "deprecated compatibility check; the saved Run binding is authoritative")
  .description("inspect durable facts and continue the next deterministic action")
  .action(async (options: { runId: string; task?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.resume(options.runId, options.task ? resolve(options.task) : undefined)),
    );
  });

program
  .command("verify")
  .requiredOption("--run-id <id>")
  .option("--task <path>", "deprecated compatibility check; the saved Run binding is authoritative")
  .description("run configured verification in the task worktree")
  .action(async (options: { runId: string; task?: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.verify(options.runId, options.task ? resolve(options.task) : undefined)),
    );
  });

program
  .command("mark-merged")
  .requiredOption("--run-id <id>")
  .requiredOption("--repository <path>")
  .requiredOption("--merge-sha <sha>")
  .description("record a supplied real merge commit without performing a merge")
  .action(async (options: { runId: string; repository: string; mergeSha: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(orchestrator.markMerged(options.runId, resolve(options.repository), options.mergeSha)),
    );
  });

function createOrchestrator(loopHome: string): Orchestrator {
  const profileName = parseProviderProfileName(
    program.opts<{ providerProfile: string }>().providerProfile,
  );
  const codex = new CodexCliAdapter({
    sandbox: "workspace-write",
    model: process.env.AGENT_LOOP_CODEX_MODEL ?? null,
  });
  const claude = new ClaudeCodeAdapter({
    model: process.env.AGENT_LOOP_CLAUDE_MODEL ?? null,
  });
  const deepseek = configuredPiAdapter();
  return new Orchestrator({
    loopHome,
    providerProfile: createProviderProfile(profileName, {
      codex: { adapter: codex, family: "codex", name: "Codex CLI" },
      claude: { adapter: claude, family: "claude", name: "Claude Code" },
      deepseek: { adapter: deepseek, family: "deepseek", name: "Pi / configured DeepSeek" },
    }),
    projectAdapter: new GenericNodeProjectAdapter(),
    roleOutputSchemas: defaultRoleOutputSchemas(),
  });
}

async function withOrchestrator(action: (orchestrator: Orchestrator) => Promise<void>): Promise<void> {
  const orchestrator = createOrchestrator(resolve(program.opts<{ loopHome: string }>().loopHome));
  try {
    await action(orchestrator);
  } finally {
    orchestrator.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseProviderProfileName(value: string): ProviderProfileName {
  if (providerProfileNames.includes(value as ProviderProfileName)) return value as ProviderProfileName;
  throw new Error(`Unknown Provider profile: ${value}`);
}

function configuredPiAdapter(): ProviderAdapter {
  const provider = process.env.AGENT_LOOP_PI_PROVIDER?.trim();
  const highCapability = process.env.AGENT_LOOP_PI_HIGH_MODEL?.trim();
  const fastAuxiliary = process.env.AGENT_LOOP_PI_FAST_MODEL?.trim();
  if (!provider || !highCapability || !fastAuxiliary) return new UnconfiguredPiAdapter();
  return new PiAdapter({
    provider,
    routes: {
      highCapability: { id: highCapability },
      fastAuxiliary: { id: fastAuxiliary },
    },
    route: "highCapability",
  });
}

class UnconfiguredPiAdapter implements ProviderAdapter {
  readonly workspaceIsolation = { readOnly: "unverified", workspaceWrite: "unverified" } as const;

  async probe() {
    return { available: false, identity: this.identity(), error: "Pi Provider/model routes are not configured" };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    return {
      invocationId: request.invocationId,
      ok: false,
      cancelled: false,
      identity: this.identity(),
      threadId: null,
      events: [],
      finalOutput: null,
      stderr: "Set AGENT_LOOP_PI_PROVIDER, AGENT_LOOP_PI_HIGH_MODEL, and AGENT_LOOP_PI_FAST_MODEL",
      exitCode: null,
      signal: null,
      durationMs: 0,
      usage: null,
      failureClass: "unavailable",
      eventsPath: resolve(request.artifactDirectory, "events.jsonl"),
      finalOutputPath: resolve(request.artifactDirectory, "final.json"),
      stderrPath: resolve(request.artifactDirectory, "stderr.log"),
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  private identity() {
    return {
      provider: "pi-unconfigured",
      model: null,
      executable: "pi",
      version: null,
    };
  }
}

await program.parseAsync();
