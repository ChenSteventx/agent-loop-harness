# P2-00 — Three fixed execution templates and simple risk routing

Phase 1 must already pass. Read `AGENTS.md` and preserve the existing lifecycle.

Implement only three templates:

- `solo`: Author -> verification.
- `assisted`: read-only Explorer -> Author -> verification.
- `reviewed`: Author -> verification and independent review -> at most one repair -> verification.

Add risk values `low | normal | high | unknown` and deterministic routing defaults. Unknown may investigate but cannot become ready until classified. An Agent may propose risk escalation but cannot lower the deterministic risk floor.

Do not implement an arbitrary DAG, graph compiler, recursive delegation, voting, or arbitration.

Add tests for routing and for the rule that low-risk work uses the cheapest valid template by default.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
