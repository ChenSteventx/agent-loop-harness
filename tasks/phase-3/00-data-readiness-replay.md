# P3-00 — Data readiness, metrics, and historical replay

Phase 2 must pass. First inspect whether there are enough real successful, failed, fallback, and human-intervention Runs to evaluate changes.

Implement:

- A metrics projection from immutable Run/Operation/Evidence/Finding facts.
- Historical replay that uses recorded task/config/context manifests and verification commands without overwriting original facts.
- Golden and Holdout task manifests with explicit separation.
- Primary metrics: accepted task rate, lead time, cost/usage, repair rounds, fallback, human intervention, confirmed findings, false positives, and post-merge failures.

If real data is insufficient, implement the mechanism and fixtures but return `blocked` for enabling any optimization or canary. Do not fabricate benefits or sample size.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
