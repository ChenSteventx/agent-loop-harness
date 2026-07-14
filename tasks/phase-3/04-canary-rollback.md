# P3-04 — Low-risk Canary and deterministic rollback

Implement Canary only for explicitly low-risk, reversible configuration such as context ranking, retrieval top-k, non-security prompt wording, low-risk provider weights, retry interval, cache TTL, or notification aggregation.

Canary configuration must limit project, task percentage, risk level, time window, budget, and rollback thresholds. High-risk tasks never enter an automatic Canary.

Metric deterioration triggers deterministic restoration of the prior Champion and records a Decision Record and Outbox event.

Canary must be disabled by default. Tests use fixtures; do not enable it against real tasks during this card.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
