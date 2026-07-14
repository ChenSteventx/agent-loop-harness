# Phase 1 architecture

Phase 1 is one deterministic application with one writable Author. It is not an agent graph.

## Boundaries

- `domain.ts` owns the small Run lifecycle and the Run, Operation, Evidence, and Event facts.
- `store.ts` is the single SQLite state authority. Run changes and their Events share a transaction.
- `execution.ts` obtains Git facts, creates isolated Git worktrees, and records real command process facts.
- `provider.ts` adapts `codex exec --json` into captured process and JSONL facts. Provider output never changes Run state directly.
- `project.ts` loads validated YAML and supplies a generic Node project policy.
- `orchestrator.ts` is the only coordinator. It invokes one Author, verifies a committed worktree, installs commit-bound Evidence, and requests legal deterministic transitions.
- `cli.ts` exposes bounded commands. `mark-merged` records an existing current repository HEAD and never performs a merge.

`LOOP_HOME` contains the SQLite database, task worktrees, and command/provider artifacts. It defaults to the private `~/.agent-loop-harness` directory, outside target repositories. Target repositories contain only Git-authored task changes.

## Recovery and evidence

Verification Evidence depends on the observed commit SHA, project policy version, and step identity. A changed dependency invalidates old Evidence before the Run can return to `ready`.

Resume reads the durable Run, Operation, Event, Evidence, worktree existence, HEAD, and dirty state. If a provider committed before a crash but its Operation was not finished, resume recognizes the changed clean HEAD, installs the missing deterministic state once, and does not invoke the Author again. Unknown or dirty states fail closed.

After a human merge, `mark-merged` requires the supplied SHA to be the current HEAD of the supplied repository. Resume runs post-merge commands there. Failure keeps the merge SHA and blocks with a remediation instruction; success permits `merged -> done`.

## Codex executable portability

The Codex launch boundary is configurable. An explicit adapter `executable` takes precedence, followed by `CODEX_BIN`.

Non-interactive runs use `--ignore-user-config`. Authentication is retained, while `config.toml` model, MCP, and sandbox defaults cannot change a bounded harness run. Codex may still discover user-level skills independently and report invalid-skill warnings; those warnings are captured in the provider artifacts.

Native Windows runs explicitly select the recommended elevated sandbox implementation. Set `CODEX_WINDOWS_SANDBOX=unelevated` only when elevated sandbox setup is unavailable. WSL and other Unix-like platforms do not receive this Windows-only override.

- On Windows, the default resolver prefers the npm-installed `@openai/codex/bin/codex.js` found through `PATH` and launches it with the current Node executable. This avoids relying on PowerShell aliases, `.cmd` execution rules, or WindowsApps aliases.
- On WSL, Linux, and macOS, the default remains the native `codex` command from `PATH`.
- `CODEX_BIN` may point to a native executable, a `codex.js` entry, or the Windows npm `codex.cmd` wrapper. JavaScript and recognized npm wrapper paths are normalized to a direct Node launch.

For a WSL migration, install and authenticate Codex inside WSL rather than reusing the Windows binary. Set `CODEX_BIN` only when the WSL command is outside the normal `PATH`.

### WSL managed-sandbox verification fallback

Some managed WSL environments allow repository edits but deny the nested processes or temporary paths needed by a test runner inside Codex's `workspace-write` sandbox. The continuous runner has an explicit, default-off compatibility path for that case:

```bash
CODEX_EXTERNAL_VERIFICATION_FALLBACK=1 node automation/continue.mjs phase-1
```

This does not disable the Codex sandbox. It permits only the structured `external_verification_required` report status, and only when the report contains a failed or unavailable command plus a non-empty `not_verified` list. The deterministic runner then executes the manifest verification commands outside the Codex sandbox. A card advances only when those real commands all exit zero. Normal test failures and incomplete work remain blocked. See `docs/WSL.zh-CN.md` for the paste-ready WSL command block.

## Real Codex manual smoke test

Run this only after `codex login status` succeeds. The commands create a disposable repository; they do not turn the embedded example directory into a nested repository.

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $env:TEMP "agent-loop-example-$stamp"
$loopHome = Join-Path $env:TEMP "agent-loop-state-$stamp"
$tsx = Join-Path (Get-Location) "node_modules\.bin\tsx.cmd"

Copy-Item -Recurse -Force .\examples\node-project $target
git -C $target init -b main
git -C $target config user.name "Agent Loop Smoke"
git -C $target config user.email "agent-loop@example.invalid"
git -C $target add -A
git -C $target commit -m "chore: initialize generic example"

$runArgs = @(
  "src/cli.ts"
  "--loop-home"
  $loopHome
  "run"
  "--run-id"
  "smoke-3"
  "--task"
  (Join-Path $target "task.yaml")
  "--repository"
  $target
)

& $tsx @runArgs

$statusArgs = @(
  "src/cli.ts"
  "--loop-home"
  $loopHome
  "status"
  "--run-id"
  "smoke-3"
)

& $tsx @statusArgs
```

The arrays intentionally avoid PowerShell continuation characters and npm argument forwarding. Paste the whole block at once. Use a new Run ID for every retry so durable facts from a failed smoke run cannot be mistaken for a fresh run.

The equivalent WSL entry keeps the same CLI contract:

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
target="$(mktemp -d)/agent-loop-example-$stamp"
loop_home="$(mktemp -d)/agent-loop-state-$stamp"

cp -R examples/node-project "$target"
git -C "$target" init -b main
git -C "$target" config user.name "Agent Loop Smoke"
git -C "$target" config user.email "agent-loop@example.invalid"
git -C "$target" add -A
git -C "$target" commit -m "chore: initialize generic example"

run_args=(
  src/cli.ts
  --loop-home "$loop_home"
  run
  --run-id smoke-3
  --task "$target/task.yaml"
  --repository "$target"
)

./node_modules/.bin/tsx "${run_args[@]}"

status_args=(
  src/cli.ts
  --loop-home "$loop_home"
  status
  --run-id smoke-3
)

./node_modules/.bin/tsx "${status_args[@]}"
```

Expected result: Codex works only in the selected loop home's `worktrees/smoke-3`, commits the bounded example change, the real Node test exits zero, and the Run becomes `ready`. Human review and merge remain separate actions.
