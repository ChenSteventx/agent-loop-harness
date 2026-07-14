# P2-01 — Read-only Explorer

Implement a bounded Explorer role for the `assisted` template.

Requirements:

- Read-only workspace and tool contract.
- Input: task spec, baseline/current commit, allowed repository roots, context budget.
- Structured output: relevant files/symbols, likely affected tests, concrete evidence, important unknowns.
- Explorer output is advisory and cannot change Run state or write implementation files.
- Author receives a compact report, not the Explorer's full transcript.
- Record cost, latency, and whether the report was used.

Use a Fake Provider in tests. Prove that attempted writes are rejected by the Harness boundary.

Do not enable parallel writers or free Agent-to-Agent chat.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
