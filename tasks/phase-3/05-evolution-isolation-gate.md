# P3-05 — Evolution isolation and final Phase 3 Gate

Close Phase 3 and prove the evolution boundary.

Requirements:

- Evolution code reads redacted/exported facts and writes only Candidate Memory, Proposals, evaluation results, Challenger config, and Decision Records.
- It has no import or runtime capability to update formal Run state, Gate results, acceptance, security policy, permissions, audit history, or production merge rights.
- Learning, replay, shadow, canary, rollback notification, or report failure cannot block an already valid development result.
- Memory is project-scoped, expirable, invalidatable, deletable, and rollback-aware.
- Promotion cannot occur from a single successful task or model self-assessment.
- Holdout and severe-failure regression tests are mandatory before promotion.

Run the full suite, audit for benchmark leakage and duplicate truth sources, and document the exact manual approvals still required.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
