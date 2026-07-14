# Mission

Build a small, generic, evidence-driven development harness for coding agents.

This repository is a standalone platform. Do not inspect, import, reference, or modify any external business repository while building it.

# KISS boundaries

- Implement only the current task card and current phase.
- Prefer plain TypeScript functions and small services over frameworks.
- Do not add dynamic agent DAGs, distributed coordination, vector databases, dashboards, microservices, autonomous online evolution, or multiple writable agents unless a later task explicitly requires them.
- Do not create a new persistent lifecycle state for an internal operation.
- Do not create abstractions without a current caller, test, invariant, or recovery need.
- Keep one npm package until independent publication is proven necessary.

# Deterministic authority

- LLM output is a proposal, patch, finding, or diagnosis; it is not proof.
- Run state changes only through deterministic application code.
- Command and test results come from real process execution and exit codes.
- Git is authoritative for commits and diffs.
- Evidence must be bound to the current commit and policy version.
- A changed commit invalidates dependent evidence.
- Unknown important conditions fail closed at ready/merge boundaries.

# Safety and isolation

- Work only inside the current repository or a worktree explicitly created by this repository.
- Never print, persist, or commit secrets, tokens, authentication caches, or complete sensitive environment values.
- Do not push, merge, rebase, or rewrite remote history.
- Do not weaken, delete, skip, or rewrite failing tests to make implementation pass.
- Do not change acceptance criteria to fit the patch.
- Do not use TODOs or placeholders for required behavior.
- Do not modify `automation/`, `tasks/`, or `plan/` unless the current card explicitly requests it.

# Phase 1 constraints

Phase 1 uses one Author and no Subagents. Implement only:

- task specification loading
- Run, Operation, Evidence, Event, and Finding where required
- SQLite persistence
- Git and worktree isolation
- command execution
- one Codex CLI provider adapter
- open, ready, merged, done, blocked, failed, cancelled
- evidence invalidation
- crash-safe resume
- one generic example project adapter

# Working protocol

1. Read the current task card and inspect the current repository state.
2. State a plan of no more than five bullets in your working notes.
3. Implement the smallest coherent change.
4. Run the narrowest relevant checks, then the required phase checks.
5. Fix failures within the current card before adding scope.
6. Report actual commands, exit codes, changed files, unverified items, risks, and the next deterministic command.

# Completion rule

A task is not complete because an agent says it is complete. It is complete only when required deterministic checks pass and the final report accurately records the evidence.
