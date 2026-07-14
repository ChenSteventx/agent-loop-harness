# P2-05 — Pi / DeepSeek adapter

Implement a Pi-based ProviderAdapter for configurable DeepSeek models.

Requirements:

- Probe the actually installed Pi interface and prefer structured RPC/JSON capabilities when available.
- Model IDs and display names come from configuration/probe results, not hard-coded marketing labels.
- Support a high-capability reviewer/author route and a fast auxiliary route as configuration, without asserting specific IDs when they cannot be verified.
- Capture provider/model identity, Pi version, usage, timeout, cancellation, and failure class.
- Tests use a fake Pi/RPC process and cover malformed output, unavailable CLI, transient failure, and quota-like error.

Do not allow Pi to become the State or Gate writer. Do not add recursive Agent calls.


## Final report

Return only JSON matching `automation/report.schema.json`.

Use `status = "completed"` only if the current task is implemented and the real required commands passed. Record actual commands and exit codes. Put environment limitations in `not_verified`; do not invent successful results.
