# P2-02 — Independent Reviewer and structured Findings

Implement the `reviewed` template without changing the Phase 1 lifecycle.

Requirements:

- Reviewer is read-only and bound to a fixed reviewed commit and diff hash.
- Reviewer first-pass context contains task spec, acceptance, diff, and verification evidence, but not Author self-evaluation.
- Structured Finding: id, category, severity, claim, location, evidence/reproduction command, expected/observed result, confidence, proposed verification, reviewer identity, reviewed commit, and status.
- A commit change invalidates old review evidence.
- At most one automatic repair round in the fixed template.
- No majority vote; conflicts first become evidence requests or deterministic experiments.

Tests must cover stale review invalidation, read-only enforcement, and findings without evidence being non-blocking unless policy explicitly says otherwise.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
