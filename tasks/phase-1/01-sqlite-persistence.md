# P1-01 — SQLite persistence and idempotent state updates

Read `AGENTS.md` and inspect P1-00 before changing code.

## Objective

Persist the minimal models with one local SQLite database using the already installed `better-sqlite3` dependency.

Implement only:

- Migrations for `runs`, `operations`, `events`, and `evidence`.
- A transaction that updates the current Run and appends its Event atomically.
- A unique `idempotency_key` for installing an Operation result once.
- Read APIs needed by later cards: create/get/update Run, append/list Event, create/finish Operation, install/list/invalidate Evidence.
- Database location supplied by configuration; tests use temporary directories.
- Clear errors for duplicate or illegal transitions.

Add tests for transaction rollback, duplicate operation installation, persistence across reopen, and legal/illegal transitions through the persistence API.

## Non-goals

No hash chain, separate snapshot store, lease/fencing, multiple writers, distributed queue, content-addressed store, provider, worktree, notification, or memory.

Keep SQL and mapping code direct. Do not build a generic ORM or repository framework.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
