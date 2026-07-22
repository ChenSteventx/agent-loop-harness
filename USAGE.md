# Using agent-loop-harness

A practical walkthrough. The one rule to keep in mind throughout: **the model
proposes, deterministic code decides.** The harness owns the Git commit and
runs the real verification commands; `ready`/`done` is decided by exit codes
bound to a commit, never by anything a model — including you — says.

## Requirements

- Node.js 20+ (22 recommended) and Git 2.40+
- One authenticated provider CLI on PATH: Codex CLI, Claude Code, or a
  Pi/DeepSeek endpoint
- A target repository that is a clean Git working tree

## Install

```bash
git clone https://github.com/ChenSteventx/agent-loop-harness.git
cd agent-loop-harness
npm ci
npm i -g .          # gives the `agent-loop` command
```

Without the global install, replace `agent-loop` below with `npm run loop --`
run from a checkout.

## The common path: one bounded run

This is the 90% use case — get a change made with a real, replayable proof.

### 1. Write a task file

A task is a small YAML file (it can live anywhere; it need not be inside the
target repo). The `verification` commands *are* the proof, so choose commands
that genuinely fail before the change and pass after.

```yaml
# task.yaml
id: FIX-GREET-1
goal: Make greet(name) return "Hello, <name>!", and "Hello, stranger!" when the name is empty.
acceptance:
  - greet("world") returns "Hello, world!"
  - node check.mjs exits 0
risk: low                 # low | normal | high  (high forces independent review)
verification:
  - id: check
    argv: [node, check.mjs]
```

Field notes:

- `acceptance` — at least one observable, checkable statement.
- `risk` — drives routing. `high` forces an independent review stage.
- `scope: [src/auth/]` — optional; paths the change is expected to touch. A
  change touching a risk-sensitive path raises the effective risk.
- `verification` — at least one real command in argv form.

### 2. Run the bounded loop

Pick a stable `--run-id` so the run can be resumed later.

```bash
agent-loop run --run-id r1 --task ./task.yaml --repository /path/to/repo
```

The loop explores, authors edits, makes the harness-owned commit, runs the
verification commands, reviews when risk demands it, and stops at `ready` or
`blocked`. It never merges.

To run a stronger template than the risk floor (for example, force independent
review on a low-risk task), add `--template reviewed`. Downgrades below the
floor are rejected.

### 3. Read the verdict — do not infer it

```bash
agent-loop status --run-id r1 --derived
```

`--derived` adds a read-only view: the next action, proof gaps, budget usage,
and — for a blocked run — a typed recovery disposition.

- `ready`: verification passed against the candidate commit. This is a real,
  replayable pass.
- `blocked`: act on the recovery disposition (`retryable` /
  `already-committed` / `human-action-required` / `terminal`); do not retry
  blindly.

To inspect the exact workflow contract and its durable progress without
creating, migrating, or changing formal state:

```bash
agent-loop topology --run-id r1 --format json
```

The output includes the immutable topology hash and manifest, completed and
pending edge receipts, and repair-budget usage. A run can traverse only edges
in that frozen manifest. The only backward edges are bounded repair paths from
verification or independent review, and concurrent resumes lease an edge so
its provider or command is invoked once.

### 4. Merge it yourself, then reach done

The harness does not merge. After you merge the ready candidate:

```bash
agent-loop mark-merged --run-id r1 --repository /path/to/repo --merge-sha <SHA>
agent-loop resume --run-id r1        # runs post-merge verification
```

`resume` runs the verification commands against the merged commit; passing is
what moves the run to `done`.

## Driving it from Claude Code (skill)

`skills/agent-loop/` is a Claude Code skill that runs a single bounded run and
reports the verdict faithfully. Activate it once:

```bash
ln -s "$(pwd)/skills/agent-loop" ~/.claude/skills/agent-loop
```

Then invoke `/agent-loop`, or just ask Claude to "run the harness" on a task.
It translates a plain request into the flow above, reports only what the
harness proved, and never edits the target repo or declares success itself.

## Non-Node projects

Most projects need no TypeScript adapter — a JSON config is enough. The
verification commands still come from the task file, so any stack that can
express its checks as argv commands works.

```bash
cat > project.json <<'JSON'
{
  "name": "python-service",
  "policyVersion": "python-service/v1",
  "sensitivePathSegments": ["payments/", "auth/"],
  "rewriteNodeCommands": false
}
JSON

agent-loop --project-config project.json run --run-id r1 --task ./task.yaml --repository /path/to/repo
```

`sensitivePathSegments` is required (declare "nothing sensitive" as an explicit
`[]`). The validated config content is hashed into the policy version and
frozen into the run binding, so editing it between attempts blocks the run
rather than silently reclassifying risk. The config cannot grant anything the
adapter port does not already allow: no Git metadata authority, no verdicts, no
promotion.

## Controlled self-learning (advanced, optional)

The harness can evolve a few of its own runtime settings (prompt variant,
author model, retry/timeout policy, memory retrieval) through an
offline-comparison → human-approval → guardrail-rollback cycle. The whole cycle
is drivable from the CLI:

```bash
agent-loop config champion-init --project <scope>                 # initial Champion
agent-loop run --run-id r1 --task ./task.yaml --repository /repo   # accumulate real runs
agent-loop eval dataset export --run-id r1 --id d1 --out d1.json
agent-loop proposal create --id p1 --project <scope> --target prompt-variant \
  --patch '{"promptVariant":"acceptance-first"}' --rationale "..." \
  --source-facts f1 --minimum-samples 1 --dataset-dir ./datasets
agent-loop proposal approve --id p1 --approved-by you --reason "..."
agent-loop proposal challenger --proposal-id p1 --id c1 --version 2
agent-loop eval compare run --id cmp1 --proposal-id p1 --dataset-dir ./datasets
```

Notes and current limits:

- Only targets that both change formal execution and are measurable by the
  full-task evaluator are proposable (`prompt-variant`, `provider-routing`,
  `role-model-selection` for the author seat, `retry-policy`, `timeout-policy`,
  `memory-retrieval`). `low-risk-review-rubric` is wired but configured only
  through a human-installed Champion for now.
- `config champion-init --config <json>` installs an unreviewed runtime
  configuration; use it deliberately. Without `--config` it installs the safe
  baseline.
- Pure-CLI comparisons currently support `requireHoldout: false`
  (demonstration scale). Production promotion with a trusted Holdout set is a
  known gap.
- Datasets supplied via `--dataset-dir` must carry honest kinds; a shipped
  Holdout Task relabeled to another kind is caught by an identity cross-check
  and rejected.

## Safety boundaries

- Never edit the target repo yourself to "help" a run — the harness authors and
  commits; your edits break the evidence chain.
- `.auth/` and `site.json` are credentials: never echo, log, or commit them.
- The harness only reaches `PASS`/`done` on real evidence; anything it cannot
  prove stays blocked for a human, and it never merges for you.
