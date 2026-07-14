# P2-03 — KISS Provider Supervisor

Implement a small wrapper around ProviderAdapter calls.

Requirements:

- Startup, idle/activity, absolute, and cancellation-grace time limits where supported.
- Failure classes already defined in Phase 1.
- `transient` and `rate_limit`: respect Retry-After when available and retry at most once with backoff.
- `quota`: no blind retry; request fallback.
- `auth`: block with a clear deterministic recovery command.
- `invalid_output`: one bounded retry, then fallback or block.
- Save checkpoint, provider failure evidence, and fallback history.
- Simple in-memory cooldown after repeated failures; no background health service and no distributed circuit-breaker platform.

Add deterministic tests for timeout, temporary recovery, quota, auth, malformed output, and no retry storm.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
