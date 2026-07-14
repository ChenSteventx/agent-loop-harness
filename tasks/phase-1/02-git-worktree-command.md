# P1-02 — Git, worktree, and CommandRunner

Read `AGENTS.md` and reuse the existing Core/Persistence interfaces.

## Objective

Add deterministic execution facts without adding orchestration yet.

Implement:

- `GitService`: repository root, current HEAD, branch, dirty state, diff, and diff hash.
- `WorktreeService`: create/list/remove a task worktree using explicit paths and branch names.
- Refuse to use the source checkout as a task's writable worktree when an isolated worktree is required.
- `CommandRunner` that accepts argv arrays, cwd, environment allowlist, timeout, and output limit.
- Record exit code, signal, duration, stdout/stderr artifact paths, and the commit observed before execution.
- Do not use a shell by default; shell mode must be explicit.

Tests must create temporary Git repositories and verify worktree isolation, dirty-state reporting, diff hash changes, successful command evidence, non-zero exit codes, timeout behavior, and bounded output.

## Non-goals

No Provider calls, no task Orchestrator, no command policy language, no container platform, and no multiple writers.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
