#!/usr/bin/env node
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import readline from "node:readline";
import {
  EXTERNAL_VERIFICATION_ENV,
  EXTERNAL_VERIFICATION_PROMPT,
  EXTERNAL_VERIFICATION_STATUS,
  parseExternalVerificationFallback,
  validateExternalVerificationDeferral,
} from "./external-verification-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "automation/manifest.json");
const schemaPath = resolve(root, "automation/report.schema.json");
const workRoot = resolve(root, ".codex-work");
const statePath = resolve(workRoot, "state.json");
const phaseName = process.argv[2] ?? "phase-1";
const retryDelayMs = Number(process.env.CODEX_RETRY_DELAY_MS ?? 20000);
const cardTimeoutMs = Number(process.env.CODEX_CARD_TIMEOUT_MS ?? 45 * 60 * 1000);
const verifyTimeoutMs = Number(process.env.CODEX_VERIFY_TIMEOUT_MS ?? 15 * 60 * 1000);
let externalVerificationFallback = false;
try {
  externalVerificationFallback = parseExternalVerificationFallback(
    process.env[EXTERNAL_VERIFICATION_ENV],
  );
} catch (error) {
  console.error(error.message);
  process.exit(64);
}

mkdirSync(workRoot, { recursive: true });
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const phase = manifest.phases?.[phaseName];
if (!phase) {
  console.error(`Unknown phase: ${phaseName}`);
  process.exit(64);
}

function now() {
  return new Date().toISOString();
}

function loadState() {
  if (!existsSync(statePath)) {
    return { schemaVersion: 1, createdAt: now(), updatedAt: now(), phases: {} };
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  state.updatedAt = now();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function ensurePhaseState(state, name) {
  state.phases[name] ??= {
    status: "not-started",
    completed: [],
    current: null,
    blockedReason: null,
    lastRunDir: null,
  };
  return state.phases[name];
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

if (!checkCommand("git", ["rev-parse", "--is-inside-work-tree"])) {
  console.error("This directory is not a Git repository. Run: node automation/setup.mjs");
  process.exit(1);
}
if (!checkCommand("codex", ["login", "status"])) {
  console.error("Codex is not authenticated. Run: codex login");
  process.exit(1);
}

const state = loadState();
if (phase.requires) {
  const required = ensurePhaseState(state, phase.requires);
  if (required.status !== "completed") {
    console.error(`${phaseName} requires ${phase.requires} to be completed first.`);
    process.exit(1);
  }
}
const phaseState = ensurePhaseState(state, phaseName);
phaseState.status = "running";
phaseState.blockedReason = null;
saveState(state);

let activeChild = null;
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.error("\nInterrupt requested. Saving runner state...");
  if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
});
process.on("SIGTERM", () => {
  interrupted = true;
  if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
});

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseReport(path, expectedTaskId) {
  if (!existsSync(path)) throw new Error("Codex did not produce final.json");
  const report = JSON.parse(readFileSync(path, "utf8"));
  const required = ["task_id", "status", "summary", "changed_files", "commands", "tests", "not_verified", "risks", "next_command", "suggested_commit_message"];
  for (const key of required) {
    if (!(key in report)) throw new Error(`final report is missing field: ${key}`);
  }
  if (report.task_id !== expectedTaskId) {
    throw new Error(`final report task_id ${report.task_id} does not match ${expectedTaskId}`);
  }
  if (!["completed", EXTERNAL_VERIFICATION_STATUS, "blocked", "failed"].includes(report.status)) {
    throw new Error(`invalid final report status: ${report.status}`);
  }
  return report;
}

function classifyFailure(text) {
  const value = text.toLowerCase();
  if (/quota|usage limit|insufficient (credit|balance)|hard limit/.test(value)) return "quota";
  if (/authentication|not logged in|unauthorized|forbidden|invalid api key|401|403/.test(value)) return "auth";
  if (/rate limit|too many requests|429|overload|503|temporar|connection reset|timed out|timeout|network/.test(value)) return "transient";
  return "unknown";
}

function conciseEvent(event) {
  if (event.type === "thread.started") return `session ${event.thread_id}`;
  if (event.type === "turn.completed") {
    const usage = event.usage ?? {};
    return `turn completed; input=${usage.input_tokens ?? "?"}, output=${usage.output_tokens ?? "?"}`;
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return `${event.type}: ${event.message ?? event.error?.message ?? "unknown error"}`;
  }
  const item = event.item;
  if (event.type === "item.started" && item?.type === "command_execution") {
    return `command: ${item.command ?? "started"}`;
  }
  if (event.type === "item.completed" && item?.type === "command_execution") {
    return `command completed: ${item.status ?? "unknown"}`;
  }
  return null;
}

async function runCodex(card, attempt, repairContext) {
  const runDir = resolve(workRoot, "runs", card.id, `${stamp()}-attempt-${attempt}`);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = resolve(runDir, "events.jsonl");
  const stderrPath = resolve(runDir, "stderr.log");
  const finalPath = resolve(runDir, "final.json");
  const eventsStream = createWriteStream(eventsPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });

  let prompt = readFileSync(resolve(root, card.prompt), "utf8");
  if (externalVerificationFallback) {
    const commands = (card.verify ?? []).map((command) => `- ${command}`).join("\n");
    prompt += `\n\n${EXTERNAL_VERIFICATION_PROMPT}\n\nManifest verification commands:\n${commands || "- None configured"}\n`;
  }
  if (repairContext) {
    prompt += `\n\n# Deterministic verification feedback\n\nThe previous attempt did not pass the external checks. Fix only the current task. Do not expand scope.\n\n${repairContext}\n`;
  }

  const windowsSandbox = process.env.CODEX_WINDOWS_SANDBOX ?? "elevated";
  if (process.platform === "win32" && !["elevated", "unelevated"].includes(windowsSandbox)) {
    throw new Error("CODEX_WINDOWS_SANDBOX must be elevated or unelevated");
  }
  const args = [
    "exec",
    "--ignore-user-config",
    "--json",
    "--sandbox", card.sandbox ?? "workspace-write",
    "-c", 'approval_policy="never"',
    ...(process.platform === "win32" ? ["-c", `windows.sandbox="${windowsSandbox}"`] : []),
    "-C", root,
    "--output-schema", schemaPath,
    "-o", finalPath,
    "-",
  ];

  console.log(`\n▶ ${card.id}, attempt ${attempt}`);
  console.log(`  prompt: ${card.prompt}`);
  console.log(`  output: ${relative(root, runDir)}`);

  let threadId = null;
  let stderrText = "";
  let timedOut = false;

  const exitCode = await new Promise((resolveExit) => {
    const child = spawn("codex", args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;
    child.stdin.end(prompt);

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`Codex card exceeded ${cardTimeoutMs} ms; requesting termination.`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000).unref();
    }, cardTimeoutMs);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      eventsStream.write(line + "\n");
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
          writeFileSync(resolve(runDir, "thread-id.txt"), threadId + "\n");
        }
        const message = conciseEvent(event);
        if (message) console.log(`  ${message}`);
      } catch {
        // Preserve malformed lines in events.jsonl; final validation will decide.
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrText += text;
      stderrStream.write(text);
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      stderrText += `\n${error.stack ?? error.message}\n`;
      resolveExit(1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      eventsStream.end();
      stderrStream.end();
      resolveExit(code ?? 1);
    });
  });

  return { runDir, finalPath, stderrPath, eventsPath, exitCode, threadId, stderrText, timedOut };
}

function runVerification(card, runDir) {
  const logPath = resolve(runDir, "verification.log");
  let log = "";
  const results = [];
  for (const command of card.verify ?? []) {
    console.log(`  verify: ${command}`);
    const result = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      timeout: verifyTimeoutMs,
      env: process.env,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const status = result.status ?? (result.error ? 1 : 0);
    log += `\n$ ${command}\nexit: ${status}\n${stdout}${stderr}\n`;
    results.push({ command, status, stdout, stderr, error: result.error?.message });
    console.log(`  exit: ${status}`);
    if (status !== 0) break;
  }
  writeFileSync(logPath, log);
  return { ok: results.every((item) => item.status === 0), results, logPath };
}

function verificationFeedback(verification) {
  const text = verification.results
    .filter((item) => item.status !== 0)
    .map((item) => `$ ${item.command}\nexit: ${item.status}\n${item.stdout}\n${item.stderr}\n${item.error ?? ""}`)
    .join("\n");
  return text.slice(-12000);
}

function blockPhase(reason, runDir) {
  phaseState.status = interrupted ? "interrupted" : "blocked";
  phaseState.blockedReason = reason;
  phaseState.lastRunDir = runDir ? relative(root, runDir) : null;
  saveState(state);
  console.error(`\nStopped: ${reason}`);
  console.error(`Resume with: node automation/continue.mjs ${phaseName}`);
  process.exit(interrupted ? 130 : 1);
}

for (const card of phase.cards) {
  if (interrupted) blockPhase("interrupted by user", null);
  if (phaseState.completed.includes(card.id)) {
    console.log(`✓ ${card.id} already completed; skipping.`);
    continue;
  }

  phaseState.current = card.id;
  phaseState.status = "running";
  saveState(state);

  let completed = false;
  let repairContext = null;
  const attempts = Math.max(1, Number(card.maxAttempts ?? 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCodex(card, attempt, repairContext);
    phaseState.lastRunDir = relative(root, result.runDir);
    saveState(state);

    if (interrupted) blockPhase("interrupted by user", result.runDir);

    if (result.exitCode !== 0) {
      const failure = classifyFailure(result.stderrText);
      if (failure === "quota" || failure === "auth") {
        blockPhase(`${failure} failure while running ${card.id}`, result.runDir);
      }
      if (attempt < attempts) {
        console.error(`Codex failed (${failure}); retrying after ${retryDelayMs} ms.`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
        repairContext = `The previous Codex process ended before completion. Inspect current files and continue idempotently. Failure class: ${failure}.`;
        continue;
      }
      blockPhase(`Codex invocation failed for ${card.id} (${failure})`, result.runDir);
    }

    let report;
    try {
      report = parseReport(result.finalPath, card.id);
    } catch (error) {
      if (attempt < attempts) {
        repairContext = `The previous final report was invalid: ${error.message}. Inspect the current implementation, finish the task, run checks, and return valid JSON.`;
        continue;
      }
      blockPhase(`invalid final report for ${card.id}: ${error.message}`, result.runDir);
    }

    const verificationDeferred = report.status === EXTERNAL_VERIFICATION_STATUS;
    if (verificationDeferred) {
      const policyError = validateExternalVerificationDeferral(
        report,
        externalVerificationFallback,
      );
      if (policyError) {
        blockPhase(
          `${card.id} reported an invalid external verification deferral: ${policyError}`,
          result.runDir,
        );
      }
      console.log(
        `  ${card.id} deferred sandbox verification; running deterministic manifest checks.`,
      );
    } else if (report.status !== "completed") {
      blockPhase(`${card.id} reported ${report.status}: ${report.summary}`, result.runDir);
    }

    const verification = runVerification(card, result.runDir);
    if (verification.ok) {
      phaseState.completed.push(card.id);
      phaseState.current = null;
      phaseState.blockedReason = null;
      saveState(state);
      console.log(`✓ ${card.id} completed and externally verified.`);
      completed = true;
      break;
    }

    if (attempt < attempts) {
      console.error(`Deterministic verification failed; issuing one bounded repair attempt.`);
      repairContext = verificationFeedback(verification);
      continue;
    }
    blockPhase(`deterministic verification failed for ${card.id}`, result.runDir);
  }

  if (!completed) blockPhase(`unable to complete ${card.id}`, null);
}

phaseState.status = "completed";
phaseState.current = null;
phaseState.blockedReason = null;
saveState(state);

console.log(`\n✓ ${phaseName} completed.`);
if (phaseName === "phase-1") {
  console.log("Review the diff and test evidence before starting Phase 2.");
  console.log("Next command after approval: node automation/continue.mjs phase-2");
} else if (phaseName === "phase-2") {
  console.log("Collect real run data before starting Phase 3.");
  console.log("Next command after data readiness: node automation/continue.mjs phase-3");
} else {
  console.log("All planned phases completed. Do not enable canary or promotion without human review.");
}
