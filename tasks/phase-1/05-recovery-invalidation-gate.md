# P1-05 — Recovery, evidence invalidation, and Phase 1 Gate

Read `AGENTS.md`. This task closes Phase 1; do not begin Phase 2.

## Objective

Make the existing vertical slice safe to resume and prove its Phase 1 invariants.

Implement or complete:

- Evidence dependency hash bound at minimum to commit SHA, policy version, and verification step identity.
- Commit changes invalidate dependent test/review Evidence before `ready` can be installed again.
- `resume` inspects Run, Operation, worktree existence, current HEAD, dirty state, and already installed Evidence before deciding the next deterministic action.
- Simulate a crash after provider completion but before state update; resume must not repeat destructive work blindly.
- Re-running the same idempotent operation must not duplicate installed Evidence or state events.
- `merged -> done` only after configured post-merge checks; post-merge failure preserves the fact that the merge happened and blocks or creates a remediation instruction rather than reverting history to `open`.
- A concise architecture document describing boundaries and the exact Phase 1 manual smoke command for real Codex.

Add an architecture test ensuring generic `src/` has no external project imports or special cases.

Run all tests and typecheck. Audit for unused abstractions, hidden TODOs, duplicate sources of truth, and unverified success claims. Remove unnecessary complexity found during the audit.

## Phase 1 completion evidence

The final report must explicitly state whether each item is verified:

1. deterministic lifecycle;
2. SQLite transaction and idempotency;
3. worktree isolation;
4. real command exit-code evidence;
5. Codex JSONL adapter tested with fixtures;
6. generic example Adapter;
7. evidence invalidation;
8. crash-safe resume;
9. Fake Provider end-to-end path;
10. full typecheck and test suite.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
