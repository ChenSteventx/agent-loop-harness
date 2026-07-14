# P3-01 — Lightweight Candidate Memory

Implement a small, auditable project-scoped Candidate Memory store.

Requirements:

- Fields: id, project/repository scope, operation type, content, source runs/commits, evidence refs, status, created/validated/expiry timestamps, and invalidation reason.
- Status: `candidate | evaluating | approved | rejected | deprecated | invalidated`.
- Agent may create a candidate but cannot approve it.
- Candidate memory is not injected into prompts by default.
- Manual approval/rejection and deletion commands.
- Secret/injection scanning and quarantine before approval.
- Default no cross-project sharing.

Use SQLite and lexical filtering first. Do not add embeddings, vector databases, graph memory, or automatic promotion.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
