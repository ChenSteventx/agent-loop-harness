#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, ".codex-work/state.json");

if (!existsSync(statePath)) {
  console.log("No runner state exists yet.");
  console.log("Start with: node automation/continue.mjs phase-1");
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
console.log(`Updated: ${state.updatedAt ?? "unknown"}`);
for (const [phase, value] of Object.entries(state.phases ?? {})) {
  console.log(`\n${phase}: ${value.status ?? "not-started"}`);
  console.log(`  completed: ${(value.completed ?? []).join(", ") || "none"}`);
  if (value.current) console.log(`  current: ${value.current}`);
  if (value.blockedReason) console.log(`  blocked: ${value.blockedReason}`);
  if (value.lastRunDir) console.log(`  last output: ${value.lastRunDir}`);
}
