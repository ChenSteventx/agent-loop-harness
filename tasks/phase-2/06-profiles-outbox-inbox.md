# P2-06 — Provider profiles, fallback policy, Outbox, and Human Inbox

Integrate the fixed templates and Provider Supervisor into two configuration profiles:

- `CODEX_PRIMARY`: Codex Author, Claude Reviewer, Pi/DeepSeek fallback reviewer.
- `CLAUDE_PRIMARY`: Claude Author, Codex Reviewer, Pi/DeepSeek fallback reviewer.

Requirements:

- Cross-family identity is verified by adapters/configuration, not model claims.
- Same-family review may be advisory but cannot impersonate a required independent receipt.
- High-risk work blocks or enters Human Inbox when all required independent reviewers are unavailable.
- SQLite transactional Outbox for `blocked`, `needs-human`, `provider-fallback`, `ready`, and `done` events.
- Minimal Human Inbox record: question, options, recommendation, evidence, risk, consequence, and resume command.
- A local file/log notification sink is enough; do not build a mail platform yet.

Notification delivery failure must not alter a development result after the Outbox write succeeds.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
