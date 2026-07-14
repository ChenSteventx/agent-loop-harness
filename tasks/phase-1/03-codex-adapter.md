# P1-03 — Codex CLI adapter and bounded invocation supervision

Read `AGENTS.md`. Do not invoke another live Codex process from this task's tests.

## Objective

Implement one provider port and a Codex CLI adapter suitable for later orchestration.

Implement:

- A minimal `ProviderAdapter` port with `probe`, `run`, optional `resume`, and `cancel`.
- `CodexCliAdapter` using `codex exec --json`, `--output-schema`, `-o`, explicit sandbox, and explicit working directory.
- Parse and store `thread.started`, completion/failure events, final structured output, stderr, exit code, duration, and usage when available.
- Minimal failure classes: `transient | rate_limit | quota | auth | unavailable | timeout | invalid_output | unknown`.
- Startup timeout, absolute timeout, and cancellation.
- Provider/model identity comes from adapter configuration and process facts, never from model self-report.

Use a fake executable/fixture in tests to emit JSONL, malformed JSON, timeout, quota-like errors, and non-zero exits. Do not require network or real credentials in automated tests.

## Non-goals

No Claude/Pi adapter, fallback routing, active health polling, circuit-breaker framework, subagent, or App Server integration.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
