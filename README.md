# agent-loop-harness

A small, generic, evidence-driven development harness for coding agents.

The model proposes; deterministic code decides. Run state, Git commits,
command exit codes, verification evidence, review validation, and promotion
of learned configuration are all owned by the harness — a model saying
"tests pass" is never proof. See `README.zh-CN.md` for the full
documentation (Chinese) and `AGENTS.md` for the hard boundaries.

## Requirements

- Node.js 20+ (22 recommended)
- Git 2.40+
- At least one provider CLI on PATH: Codex CLI, Claude Code, or a
  Pi-compatible DeepSeek endpoint

## Quick start

```bash
git clone https://github.com/ChenSteventx/agent-loop-harness.git
cd agent-loop-harness
npm ci
npm run typecheck && npm test   # optional but recommended

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
npm run loop -- run --task /path/to/your-repo/task.yaml --repository /path/to/your-repo

# Inspect durable state, plus the derived view (next action, proof gaps,
# budget usage, typed recovery):
npm run loop -- status --run-id <RUN_ID> --derived
```

The harness never merges. After you merge the ready candidate yourself:

```bash
npm run loop -- mark-merged --run-id <RUN_ID> --repository /path/to/your-repo --merge-sha <SHA>
```

Post-merge verification on the merged commit is what moves the run to
`done`.

## Non-Node projects

Most projects need no TypeScript adapter — a declarative config is enough:

```bash
cat > project.json <<'JSON'
{
  "name": "python-service",
  "policyVersion": "python-service/v1",
  "sensitivePathSegments": ["payments/", "auth/"],
  "rewriteNodeCommands": false
}
JSON

npm run loop -- --project-config project.json run --task ... --repository ...
```

Verification commands come from the task file, so any stack that can
express its checks as argv commands works. The config cannot grant what
the adapter port does not allow: no Git metadata authority, no verdicts,
no promotion rights.

## Status

Alpha-quality engineering prototype. The package is intentionally not
published; install from a checkout. No license has been granted yet — all
rights reserved until one is added.
