#!/usr/bin/env node
// Keep the top-level help path independent of the database, orchestration,
// evaluation, and OCI module graph. Besides making `--help` reliable on slow
// filesystems, this guarantees that asking for usage information cannot open
// state or probe an execution backend.
const topLevelCommands = new Set([
  "init", "run", "status", "topology", "resume", "verify", "mark-merged", "metrics", "eval",
  "replay", "shadow", "proposal", "config", "canary", "notify", "human", "memory",
]);
const arguments_ = process.argv.slice(2);
const requestsTopLevelHelp = arguments_.some((argument) => argument === "--help" || argument === "-h") &&
  !arguments_.some((argument) => topLevelCommands.has(argument));
const selected = selectedCommand(arguments_);
const usesFastCli = !arguments_.some((argument) => argument === "--help" || argument === "-h") && (
  selected[0] === "init" ||
  (selected[0] === "config" && selected[1] === "champion-init") ||
  (selected[0] === "proposal" && selected[1] === "create") ||
  (selected[0] === "notify" && selected[1] === "digest")
);

if (requestsTopLevelHelp) {
  process.stdout.write(`Usage: agent-loop [options] [command]

Evidence-driven bounded coding loop

Options:
  --loop-home <path>         external state directory
  --provider-profile <name>  fixed Provider profile: CODEX_PRIMARY or CLAUDE_PRIMARY
  --project-config <path>    declarative project config JSON; defaults to the built-in generic-node adapter
  -h, --help                 display help for command

Commands:
  init                       initialize the private loop state directory
  run [options]              create a worktree and execute the fixed risk-routed proof loop
  status [options]           show durable run state after completion or interruption
  topology [options]         show the frozen workflow topology and durable edge traversals
  resume [options]           inspect durable facts and continue the next deterministic action
  verify [options]           run configured verification in the task worktree
  mark-merged [options]      record a supplied real merge commit without performing a merge
  metrics                    project metrics from durable development facts
  eval                       offline evaluation controls
  replay [options]           top-level alias for immutable Historical Replay
  shadow                     non-authoritative Shadow reports
  proposal                   configuration-only Change Proposals
  config                     Champion activation and rollback decisions
  canary                     disabled-by-default low-risk Canary controls
  notify                     dispatch existing transactional Outbox notifications
  human                      record explicit human decisions
  memory                     quarantined project-scoped Candidate Memory
  help [command]             display help for command
`);
} else if (usesFastCli) {
  // npm's prepare/pretest hooks keep dist current. Prefer the built module so
  // repeated CLI subprocesses do not pay TypeScript transformation cost; a
  // source-only checkout still has a correct (slower) fallback.
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const builtFastCli = new URL("../dist/cli-fast.js", import.meta.url);
  const implementation = existsSync(fileURLToPath(builtFastCli))
    ? await import(builtFastCli.href)
    : await import("./cli-fast.js");
  await implementation.runFastCli(arguments_);
} else {
  await import("./cli-main.js");
}

function selectedCommand(argv: readonly string[]): readonly [string | null, string | null] {
  const positional: string[] = [];
  const globalValueOptions = new Set(["--loop-home", "--provider-profile", "--project-config"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (globalValueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) positional.push(argument);
    if (positional.length === 2) break;
  }
  return [positional[0] ?? null, positional[1] ?? null];
}
