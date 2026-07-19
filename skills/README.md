# Skills

Claude Code skills that ship with the harness.

## agent-loop

Drives a single bounded run and reports the harness verdict faithfully
(deterministic authority: the harness owns the commit and the pass/fail).

Activate it by making it discoverable to Claude Code — copy or symlink it
into a skills directory Claude Code reads (global, or a project's
`.claude/skills/`):

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/agent-loop" ~/.claude/skills/agent-loop
```

Then invoke it with `/agent-loop` or by asking Claude to "run the harness"
on a task. It uses the installed `agent-loop` CLI (`npm i -g .`), falling
back to `npm run loop --` from a checkout.
