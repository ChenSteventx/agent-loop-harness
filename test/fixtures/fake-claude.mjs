#!/usr/bin/env node

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.209 (Claude Code)\n");
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const resumeIndex = process.argv.indexOf("--resume");
const required = ["--print", "--output-format", "--json-schema"];
if (required.some((argument) => !process.argv.includes(argument))) {
  process.stderr.write("missing documented Claude Code argument\n");
  process.exit(2);
}
if (process.argv.includes("--tools") && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1") {
  process.stderr.write("read-only invocation did not disable auto memory\n");
  process.exit(2);
}
if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "quota") {
  process.stderr.write("API usage limit reached\n");
  process.exit(1);
} else if (mode === "malformed") {
  process.stdout.write("not json\n");
} else {
  const output = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "claude-session-1",
    structured_output: { status: "completed", source: "claude-fixture" },
    usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
