# Changelog

## 0.1.0 - 2026-07-22

### Added

- Runs now freeze a validated `solo`, `assisted`, or `reviewed` workflow topology at creation, so resume cannot silently reroute work after risk or configuration changes.
- `agent-loop topology --run-id <RUN_ID> --format json` now shows the frozen manifest, durable edge history, pending edge, and repair-budget usage without migrating or modifying formal state.

### Reliability

- Topology compilation, ordered guard evaluation, and traversal action reconstruction now share one typed transition registry; frozen manifests must match its complete node/edge projection, and unknown proof requirements fail closed.
- Workflow edges use durable SQLite traversal receipts, a shared finite repair budget, and atomic execution leases for single-live-owner execution and durable duplicate suppression during concurrent resume. External effect-before-receipt windows are explicitly not claimed as exactly-once.
- Crash recovery validates every pending receipt against its frozen edge, action, budget ordinal, topology hash, and deterministic identity before continuing.
- Active legacy V1 runs and tampered V2 bindings fail closed, while terminal legacy facts remain readable. V1 recovery is explicitly start-new-run; there is no in-place migration or transfer of legacy Evidence/worktrees.
