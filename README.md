# agent-loop-harness

A small, generic, evidence-driven development harness for coding agents.

The model proposes; deterministic code decides. Run state, Git commits,
command exit codes, verification evidence, review validation, and promotion
of learned configuration are all owned by the harness — a model saying
"tests pass" is never proof. See `USAGE.md` for a full practical
walkthrough, `README.zh-CN.md` for the full documentation (Chinese),
`docs/ARCHITECTURE.md` for the runtime boundaries, and `AGENTS.md` for the
hard constraints. Release notes are in `CHANGELOG.md`.

## Requirements

- Node.js 20+ (22 recommended)
- Git 2.40+
- Docker or Podman and a locally available verification image pinned by digest
- At least one provider CLI on PATH: Codex CLI, Claude Code, or a
  Pi-compatible DeepSeek endpoint

## Quick start

```bash
git clone https://github.com/ChenSteventx/agent-loop-harness.git
cd agent-loop-harness
npm ci
npm run typecheck && npm test   # optional but recommended

# Optional: install as a command (agent-loop). Otherwise use `npm run loop --`.
npm i -g .

# Formal verification fails closed without an OCI runtime and immutable image.
export AGENT_LOOP_OCI_ENGINE=docker  # or podman
export AGENT_LOOP_OCI_IMAGE='registry.example/agent-loop-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

# A task is a small YAML file inside the target repository:
cat > /path/to/your-repo/task.yaml <<'YAML'
id: HELLO-1
goal: Create hello.txt containing "hello"
acceptance:
  - hello.txt exists and contains hello
risk: low
verification:
  - id: check
    argv: [sh, -c, "grep -q hello hello.txt"]
YAML

# Run the bounded loop: explore -> author -> harness-owned commit ->
# real verification -> (review when risk demands it) -> ready
# (--template reviewed escalates above the risk floor; downgrades are rejected)
agent-loop run --run-id r1 --task /path/to/your-repo/task.yaml --repository /path/to/your-repo

# Inspect durable state, plus the derived view (next action, proof gaps,
# budget usage, typed recovery):
agent-loop status --run-id r1 --derived

# Inspect the immutable workflow and durable edge history without writing state:
agent-loop topology --run-id r1 --format json
```

Every run freezes one validated `solo`, `assisted`, or `reviewed` topology.
The topology is a policy whitelist for deterministic controller decisions, not
a token-flow graph. Only the declared verification/review repair edges can move
backward, and they share a finite repair budget. Concurrent resumes use durable
receipts and an atomic lease to enforce one live executor per edge. This
suppresses known duplicates, but does not promise exactly-once external effects
across an effect-before-receipt crash window.

Commands are shown as `agent-loop <...>`; from a checkout without the global
install, use `npm run loop -- <...>` instead.

## Claude Code skill

`skills/agent-loop/` is a Claude Code skill that drives a single bounded run
and reports the harness verdict faithfully. Activate it with
`ln -s "$(pwd)/skills/agent-loop" ~/.claude/skills/agent-loop`, then invoke
`/agent-loop` (see `skills/README.md`).

The harness never merges. After you merge the ready candidate yourself:

```bash
npm run loop -- mark-merged --run-id <RUN_ID> --repository /path/to/your-repo --merge-sha <SHA>
npm run loop -- resume --run-id <RUN_ID>
```

`resume` then runs post-merge verification on the merged commit; passing
is what moves the run to `done`.

## Non-Node projects

Most projects need no TypeScript adapter — a declarative config is enough:

```bash
cat > project.json <<'JSON'
{
  "name": "python-service",
  "policyVersion": "python-service/v1",
  "verificationImage": "registry.example/python-verifier@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sensitivePathSegments": ["payments/", "auth/"],
  "rewriteNodeCommands": false
}
JSON

npm run loop -- --project-config project.json run --task ... --repository ...
```

Verification commands come from the task file, so any stack that can
express its checks as argv commands works. The config cannot grant what
the adapter port does not allow: no Git metadata authority, no verdicts,
no promotion rights. `sensitivePathSegments` is required — declaring
"nothing is sensitive" takes an explicit `[]`. The validated config
content is hashed into the effective policy version and frozen into the
run binding, so editing the config between attempts blocks the run
instead of silently reclassifying risk.

Formal commands run against a disposable, read-only materialization of the
complete committed Git tree with network disabled. They receive only a
byte- and inode-bounded `/artifacts` tmpfs and bounded `/tmp`; validated
artifacts are copied out only after the container exits. No host home,
credentials, loop state, Git metadata, or other repository is mounted. The
configured image is never built or pulled automatically.

These OS-level guarantees are not established by the fake-runtime unit tests.
Before relying on them, run the opt-in real-runtime gate documented in
`USAGE.md` against the exact deployment runtime and image.

## Status

Alpha-quality engineering prototype. The package is intentionally not
published; install from a checkout. No license has been granted yet — all
rights reserved until one is added.
