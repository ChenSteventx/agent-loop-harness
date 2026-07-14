# P3-02 — Change Proposals and Champion/Challenger configuration

Implement versioned proposals for future Prompt, context, routing, retry, timeout, and low-risk review-rubric changes.

A proposal must contain a hypothesis, target component/level, current and candidate versions, diff, evidence refs, evaluation dataset, primary metric, guardrails, minimum sample size, success threshold, maximum regression, risk, rollback condition, and approval requirement.

Maintain exactly one active Champion and optional Challengers. Activation and rollback are deterministic commands with Decision Records.

Do not permit proposals to change security policy, secret handling, State/Gate authority, acceptance, human tests, merge permission, or audit facts.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
