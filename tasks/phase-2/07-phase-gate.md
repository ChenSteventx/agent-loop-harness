# P2-07 — Phase 2 integration Gate

Close Phase 2 without adding Phase 3 features.

Prove with tests and fixtures:

- `solo`, `assisted`, and `reviewed` routing.
- Explorer and Reviewer cannot write Author files.
- No Agent can create a grandchild Agent.
- Reviewed commit/diff changes invalidate review evidence.
- Temporary failure retries are bounded.
- Quota routes to configured fallback without being confused with low-quality output.
- Auth and unknown failures block with deterministic recovery commands.
- CODEX_PRIMARY and CLAUDE_PRIMARY use the same Core lifecycle.
- Outbox failure does not change Run completion.
- Metrics record Agent calls, latency, cost/usage when available, confirmed findings, and false positives.

Audit and delete unused abstractions. Do not implement dynamic DAG, long-term memory, shadow, or canary.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
