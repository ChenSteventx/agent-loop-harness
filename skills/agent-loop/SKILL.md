---
name: agent-loop
description: Run a coding task through the agent-loop-harness — an evidence-driven bounded loop where deterministic code, not the model, owns the commit and the verdict. Use when the user wants a change made to a repository with a real, replayable pass/fail proof rather than a model's say-so, or asks to "run the harness" / "run agent-loop" on a task.
---

# agent-loop

Drive the agent-loop-harness so a coding task is completed under deterministic
authority: the harness owns the Git commit, runs the real verification
commands, and decides `ready`/`blocked` from exit codes bound to that commit.
A model — including you — never declares the task passed. Your job is to
frame the task, invoke the harness, and report its verdict faithfully.

## Prerequisites

- The `agent-loop` CLI on PATH (installed via `npm i -g .` from a harness
  checkout). If it is not installed, run from a checkout with
  `npm run loop --` in place of `agent-loop`.
- A provider CLI the harness can drive (Codex CLI, Claude Code, or a
  Pi/DeepSeek endpoint) already authenticated.
- A target repository that is a clean Git working tree.

## Steps

1. **Establish the task.** If the user points at an existing task YAML, use
   it. Otherwise write one to a temp file (not inside the target repo unless
   they ask) following this exact schema — it is validated strictly:

   ```yaml
   id: SHORT-STABLE-ID            # e.g. FIX-LOGIN-1
   goal: One sentence of intent.
   acceptance:                    # at least one; observable, not vibes
     - concrete, checkable statement
   risk: low                      # low | normal | high | unknown
   scope: [src/auth/]             # optional: paths the change should touch
   verification:                  # at least one; real commands, argv form
     - id: check
       argv: [sh, -c, "the command that must exit 0"]
   ```

   The `verification` commands are the proof. Choose commands that genuinely
   fail before the change and pass after (a test, a build, a grep). Risk
   drives routing: `high` forces independent review.

2. **Run the bounded loop.** Pick a stable `--run-id` so the run can be
   resumed:

   ```bash
   agent-loop run --run-id <RUN_ID> --task <TASK_YAML> --repository <REPO>
   ```

   This explores, authors edits, makes the harness-owned commit, runs the
   verification commands, reviews when risk demands it, and stops at `ready`
   or `blocked`. It never merges.

3. **Read the verdict, do not infer it.** Inspect durable state plus the
   read-only derived view:

   ```bash
   agent-loop status --run-id <RUN_ID> --derived
   ```

   - `ready`: report the candidate commit and that verification passed. This
     is a real, replayable pass — say so plainly.
   - `blocked`: report the typed recovery disposition from the derived view
     (`retryable` / `already-committed` / `human-action-required` /
     `terminal`) and the proof gap. Do not retry blindly; do what the
     disposition says.

4. **Hand off, never merge for them.** The harness does not merge. After the
   user merges the ready candidate themselves:

   ```bash
   agent-loop mark-merged --run-id <RUN_ID> --repository <REPO> --merge-sha <SHA>
   agent-loop resume --run-id <RUN_ID>
   ```

   `resume` runs post-merge verification on the merged commit; passing is
   what moves the run to `done`.

## Rules

- Report only what the harness proved. Never upgrade a `blocked` to "done" or
  claim verification passed when the status does not say `ready`/`done`.
- Never edit the target repo yourself to "help" the run — the harness authors
  and commits; your edits would break the evidence chain.
- `.auth/` and `site.json` are credentials: never echo, log, or commit them.
- If a non-Node project needs an adapter, pass `--project-config <json>`
  (see the harness README for the declarative config).
