#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { Orchestrator, defaultLoopHome } from "./orchestrator.js";
import { CodexCliAdapter } from "./provider.js";
import { GenericNodeProjectAdapter } from "./project.js";

const program = new Command()
  .name("agent-loop")
  .description("Evidence-driven single-author coding loop")
  .option("--loop-home <path>", "external state directory", process.env.LOOP_HOME ?? defaultLoopHome());

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
  .description("create a worktree and execute one Author followed by verification")
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
  .requiredOption("--task <path>")
  .description("inspect durable facts and continue the next deterministic action")
  .action(async (options: { runId: string; task: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.resume(options.runId, resolve(options.task))),
    );
  });

program
  .command("verify")
  .requiredOption("--run-id <id>")
  .requiredOption("--task <path>")
  .description("run configured verification in the task worktree")
  .action(async (options: { runId: string; task: string }) => {
    await withOrchestrator(async (orchestrator) =>
      print(await orchestrator.verify(options.runId, resolve(options.task))),
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

await program.parseAsync();

function createOrchestrator(loopHome: string): Orchestrator {
  return new Orchestrator({
    loopHome,
    provider: new CodexCliAdapter({ sandbox: "workspace-write" }),
    projectAdapter: new GenericNodeProjectAdapter(),
    outputSchemaPath: resolve("automation/report.schema.json"),
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
