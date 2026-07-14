# P3-03 — Offline comparison and Shadow evaluation

Implement:

- Champion vs Challenger vs unchanged baseline replay on selected historical, Golden, Holdout, failure-injection, and failed tasks.
- Metric and guardrail comparison without lowering acceptance standards.
- Shadow mode that records what context/provider/template/review decision a Challenger would choose while the Champion still controls execution.
- Shadow output is clearly marked non-authoritative and cannot install formal Evidence or change Run state.

Tests must prove dataset separation, no write path from Shadow to formal receipts/state, and rejection when guardrail regressions exceed configured limits.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
