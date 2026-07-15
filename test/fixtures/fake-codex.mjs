#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  if (!process.argv.includes("--ignore-user-config")) {
    process.stderr.write("missing user config isolation\n");
    process.exit(2);
  }
  if (!process.argv.includes("--ignore-rules")) {
    process.stderr.write("missing rules isolation\n");
    process.exit(2);
  }
  if (process.argv.includes("--ask-for-approval")) {
    process.stderr.write("obsolete --ask-for-approval flag\n");
    process.exit(2);
  }
  const configIndex = process.argv.indexOf("-c");
  if (configIndex < 0 || process.argv[configIndex + 1] !== 'approval_policy="never"') {
    process.stderr.write("missing deterministic approval_policy config\n");
    process.exit(2);
  }
  if (!process.argv.includes("features.hooks=false")) {
    process.stderr.write("missing disabled hooks config\n");
    process.exit(2);
  }
}

const outputIndex = process.argv.indexOf("-o");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const mode = process.env.FAKE_CODEX_MODE ?? "success";

function event(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "idle") {
  event({ type: "thread.started", thread_id: "fake-thread-idle" });
  setInterval(() => {}, 1000);
} else if (mode === "quota") {
  process.stderr.write("Quota exceeded: usage limit reached\n");
  process.exit(1);
} else if (mode === "nonzero") {
  event({ type: "thread.started", thread_id: "fake-thread-failed" });
  event({ type: "turn.failed", message: "provider process failed" });
  process.stderr.write("unexpected provider failure\n");
  process.exit(2);
} else {
  event({ type: "thread.started", thread_id: "fake-thread-1" });
  if (mode === "malformed") process.stdout.write("{not-json}\n");
  event({ type: "item.completed", item: { type: "command_execution", status: "completed" } });
  if (outputPath) writeFileSync(outputPath, JSON.stringify({ status: "completed", source: "fixture" }));
  event({
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 },
  });
}
