# P1-04 — Minimal Orchestrator, CLI, and generic example project

Read `AGENTS.md`. Keep one Author and one task worktree.

## Objective

Create the first end-to-end path with a Fake Provider in tests and a real Codex Adapter available for manual use.

Implement:

- Task YAML loading through the existing schema.
- A small Orchestrator for: create Run, create worktree, invoke Author, inspect Git, run project verification commands, install Evidence, and set `ready` only when required checks pass.
- CLI commands: `init`, `run`, `status`, `resume`, `verify`, and `mark-merged`.
- External state directory through `LOOP_HOME`, defaulting outside target projects to a user-private directory.
- A generic example Node project and Project Adapter with its own verification commands.
- Dependency injection for a Fake Provider so end-to-end tests do not call the network.
- `mark-merged` records a real supplied merge SHA; it must not perform automatic merge.

End-to-end tests must prove a Fake Provider patch can move a Run from `open` to `ready`, that missing/failed verification cannot do so, and that status output is useful after interruption.

## Non-goals

No review Agent, fallback Provider, email, dynamic DAG, automatic merge, project-specific business rules, or long-running daemon.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
