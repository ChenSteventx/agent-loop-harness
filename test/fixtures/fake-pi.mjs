#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE ?? "success";
if (process.argv.includes("--version")) { process.stdout.write("pi-fixture 1.2.3\n"); process.exit(0); }
if (process.argv.includes("--probe-json")) {
  process.stdout.write(JSON.stringify({ version: "1.2.3", rpc: true, models: [{ id: "configured-high", displayName: "Probe High" }, { id: "configured-fast", displayName: "Probe Fast" }] })); process.exit(0);
}
if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) { process.stderr.write("structured RPC required\n"); process.exit(2); }
if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "transient") { process.stderr.write("503 service temporarily unavailable\n"); process.exit(1); }
else if (mode === "quota") { process.stderr.write("insufficient balance: quota exhausted\n"); process.exit(1); }
else if (mode === "malformed") process.stdout.write("not-json\n");
else {
  process.stdin.resume(); process.stdin.once("data", () => process.stdout.write(`${JSON.stringify({ type: "result", output: { status: "reviewed" }, usage: { input_tokens: 12, output_tokens: 3 } })}\n`));
}
