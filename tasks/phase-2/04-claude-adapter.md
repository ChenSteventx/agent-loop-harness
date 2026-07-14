# P2-04 — Claude Code adapter

Implement a Claude Code ProviderAdapter without inventing CLI flags or model IDs.

Before coding, probe the actually installed CLI using version/help output and keep version-specific command construction behind the adapter. Automated tests must use a fake executable and require no real credentials.

Report provider identity, configured model identity/family, CLI version, structured-output capability, resume capability, usage when available, timeout, cancellation, and classified failures.

Do not copy Codex-specific JSONL assumptions into the generic Provider port. Do not add workflow logic to the adapter.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
