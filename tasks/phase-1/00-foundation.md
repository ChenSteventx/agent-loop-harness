# P1-00 — Minimal domain foundation

Read `AGENTS.md`. This is a fresh standalone repository. Do not inspect any external repository.

## Objective

Create the smallest TypeScript ESM foundation for the deterministic lifecycle.

Implement only:

- `Run`, `Operation`, `Evidence`, and `Event` types.
- Run statuses: `open | ready | merged | done | blocked | failed | cancelled`.
- Legal normal transitions: `open -> ready -> merged -> done`.
- Transition to `blocked | failed | cancelled` from active statuses.
- `blocked` preserves the previous status, reason, checkpoint reference, and deterministic resume command.
- A small transition validator; no workflow framework.
- A minimal `ProjectAdapter` interface.
- A Zod-backed task spec with goal, acceptance, optional scope/out-of-scope, risk, and verification commands.

Add unit tests for legal transitions, illegal transitions, blocked metadata, and task spec validation.

## Non-goals

No SQLite, Git, worktree, provider, CLI, subagent, hook, memory, notification, or evolution code. Do not create an aggregate/repository framework.

## Required checks

Run the real typecheck and tests. Keep public types small and documented only where the invariant is not obvious.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
