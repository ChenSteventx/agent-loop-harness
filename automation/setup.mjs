#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireCommand(command, args = ["--version"]) {
  const result = run(command, args, { capture: true });
  if (result.status !== 0) {
    console.error(`Required command is unavailable: ${command}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  const version = (result.stdout || result.stderr || "").trim().split("\n")[0];
  console.log(`✓ ${command}: ${version}`);
}

requireCommand("node");
requireCommand("npm");
requireCommand("git");
requireCommand("codex");

if (!existsSync(resolve(root, ".git"))) {
  let result = run("git", ["init", "-b", "main"]);
  if (result.status !== 0) {
    result = run("git", ["init"]);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const dir of ["src", "test", "examples", "docs", ".codex-work"]) {
  mkdirSync(resolve(root, dir), { recursive: true });
}

console.log("Installing npm dependencies and creating package-lock.json...");
const install = run("npm", ["install"]);
if (install.status !== 0) process.exit(install.status ?? 1);

const auth = run("codex", ["login", "status"], { capture: true });
if (auth.status !== 0) {
  console.error("Codex is not logged in. Run: codex login");
  if (auth.stderr) console.error(auth.stderr.trim());
  process.exit(auth.status ?? 1);
}
console.log(`✓ Codex authentication: ${(auth.stdout || auth.stderr || "ok").trim()}`);

console.log("\nSetup complete.");
console.log("Start Phase 1 with:");
console.log("  node automation/continue.mjs phase-1");
