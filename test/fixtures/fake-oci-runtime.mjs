#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const cliArguments = process.argv.slice(2);
const forcedLocal = cliArguments[0] === "--remote=false";
if (forcedLocal) cliArguments.shift();
const [command, ...args] = cliArguments;
const stateDirectory = process.env.AGENT_LOOP_FAKE_OCI_STATE;

if (command === "version") {
  process.stdout.write("fake-docker 1.0.0\n");
  process.exit(0);
}

if (command === "image" && args[0] === "inspect") {
  process.stdout.write("null\n");
  process.exit(0);
}

if (command === "context" && args[0] === "inspect") {
  process.stdout.write('"unix:///var/run/docker.sock"\n');
  process.exit(0);
}

if (!stateDirectory) {
  process.stderr.write("AGENT_LOOP_FAKE_OCI_STATE is required\n");
  process.exit(64);
}
mkdirSync(stateDirectory, { recursive: true });

if (command === "__delayed_run") {
  const encoded = args[0];
  if (!encoded) process.exit(64);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  await new Promise((resolveWait) => setTimeout(resolveWait, payload.delayMs));
  const child = spawn(payload.executable, payload.args, {
    cwd: payload.cwd,
    env: payload.environment,
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  writeState(payload.name, { pid: child.pid, artifacts: payload.artifacts });
  child.once("error", () => {
    removeContainer(payload.name);
    process.exit(127);
  });
  child.once("close", (code) => {
    writeState(payload.name, { pid: null, artifacts: payload.artifacts });
    process.exit(code ?? 1);
  });
  await new Promise(() => {});
}

if (command === "container" && args[0] === "inspect") {
  const name = args.at(-1);
  if (process.env.AGENT_LOOP_FAKE_OCI_INSPECT_ERROR === "1") {
    process.stderr.write("forced container inspect failure\n");
    process.exit(73);
  }
  if (!name || !existsSync(statePath(name))) process.exit(1);
  process.stdout.write(`${name}\n`);
  process.exit(0);
}

if (command === "container" && args[0] === "ls") {
  for (const name of readdirSync(stateDirectory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))) {
    process.stdout.write(`${name}\n`);
  }
  process.exit(0);
}

if (command === "kill" || command === "stop") {
  const name = args.at(-1);
  if (!name || !stopContainer(name)) process.exit(1);
  process.exit(0);
}

if (command === "rm") {
  const name = args.at(-1);
  if (!name) process.exit(64);
  const state = readState(name);
  const delayMs = Number(process.env.AGENT_LOOP_FAKE_OCI_RM_DELAY_MS ?? "0");
  if (state && Number.isSafeInteger(delayMs) && delayMs > 0 &&
      Date.now() - state.createdAt < delayMs) process.exit(73);
  removeContainer(name);
  process.exit(0);
}

if (command === "cp") {
  const source = args[0];
  const destination = args[1];
  const match = /^([^:]+):\/artifacts\/\.$/u.exec(source ?? "");
  if (!match || !destination) process.exit(64);
  const state = readState(match[1]);
  if (!state?.artifacts || !existsSync(state.artifacts)) process.exit(1);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(state.artifacts)) {
    cpSync(join(state.artifacts, name), join(destination, name), {
      recursive: true,
      dereference: false,
    });
  }
  process.exit(0);
}

if (command !== "run") {
  process.stderr.write(`unsupported fake OCI command: ${command ?? "<missing>"}\n`);
  process.exit(64);
}

const parsed = parseRun(args);
trace({
  command,
  args,
  forcedLocal,
  parsed: {
    ...parsed,
    environment: undefined,
    environmentNames: [...parsed.environment.keys()],
    tmpfsEntries: [...parsed.tmpfs.entries()],
  },
});

const workspace = parsed.mounts.get("/workspace");
const artifacts = parsed.tmpfs.has("/artifacts") && parsed.name
  ? join(stateDirectory, `${parsed.name}-artifacts`)
  : null;
const dependencies = parsed.mounts.get("/dependencies");
if (!workspace || !artifacts || !parsed.name || parsed.command.length === 0) {
  process.stderr.write("fake OCI run is missing required mounts, tmpfs, name, or command\n");
  process.exit(64);
}
mkdirSync(artifacts, { recursive: true, mode: 0o777 });

const childEnvironment = Object.fromEntries(
  [...parsed.environment.entries()].map(([name, value]) => [
    name,
    mapContainerPath(value, workspace, artifacts, dependencies),
  ]),
);
if (process.env.PATH) childEnvironment.PATH = process.env.PATH;

const executable = mapContainerPath(parsed.command[0], workspace, artifacts, dependencies);
const commandArgs = parsed.command.slice(1)
  .map((value) => mapContainerPath(value, workspace, artifacts, dependencies));
const cwd = parsed.workdir === "/workspace"
  ? workspace
  : mapContainerPath(parsed.workdir, workspace, artifacts, dependencies);
const delayedCreateMs = Number(process.env.AGENT_LOOP_FAKE_OCI_DELAYED_CREATE_MS ?? "0");
if (Number.isSafeInteger(delayedCreateMs) && delayedCreateMs > 0) {
  const payload = Buffer.from(JSON.stringify({
    delayMs: delayedCreateMs,
    name: parsed.name,
    executable,
    args: commandArgs,
    cwd,
    environment: childEnvironment,
    artifacts,
  })).toString("base64url");
  const helper = spawn(process.execPath, [process.argv[1], "__delayed_run", payload], {
    env: process.env,
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  helper.unref();
  await new Promise(() => {});
}

const child = spawn(
  executable,
  commandArgs,
  {
    cwd,
    env: childEnvironment,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
    windowsHide: true,
  },
);

writeState(parsed.name, { pid: child.pid, artifacts });

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  removeContainer(parsed.name);
  process.exit(127);
});
child.once("close", (code, signal) => {
  writeState(parsed.name, { pid: null, artifacts });
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function parseRun(values) {
  const mounts = new Map();
  const tmpfs = new Map();
  const environment = new Map();
  let name = "";
  let workdir = "/workspace";
  let entrypoint = "";
  let index = 0;
  while (index < values.length) {
    const value = values[index];
    if (value === "--rm" || value === "--read-only" || value === "--init" || value === "--no-healthcheck" || value.startsWith("--pull=") || value.startsWith("--read-only-tmpfs=") || value.startsWith("--image-volume=")) {
      index += 1;
      continue;
    }
    if (["--name", "--network", "--ipc", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--memory-swap", "--cpus", "--user", "--workdir", "--mount", "--tmpfs", "--env", "--entrypoint"].includes(value)) {
      const next = values[index + 1];
      if (next === undefined) throw new Error(`missing value after ${value}`);
      if (value === "--name") name = next;
      else if (value === "--workdir") workdir = next;
      else if (value === "--entrypoint") entrypoint = next;
      else if (value === "--env") {
        const separator = next.indexOf("=");
        if (separator < 1) throw new Error("fake OCI requires explicit NAME=VALUE environment arguments");
        environment.set(next.slice(0, separator), next.slice(separator + 1));
      }
      else if (value === "--mount") {
        const fields = Object.fromEntries(next.split(",").map((entry) => {
          const separator = entry.indexOf("=");
          return separator < 0 ? [entry, "true"] : [entry.slice(0, separator), entry.slice(separator + 1)];
        }));
        if (fields.src && fields.dst) mounts.set(fields.dst, fields.src);
      }
      else if (value === "--tmpfs") {
        const separator = next.indexOf(":");
        tmpfs.set(separator < 0 ? next : next.slice(0, separator), separator < 0 ? "" : next.slice(separator + 1));
      }
      index += 2;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`unsupported fake OCI option: ${value}`);
    return { name, workdir, mounts, tmpfs, environment, image: value, command: [entrypoint, ...values.slice(index + 1)].filter(Boolean) };
  }
  return { name, workdir, mounts, tmpfs, environment, image: "", command: [] };
}

function mapContainerPath(value, workspace, artifacts, dependencies) {
  if (value === "/workspace") return workspace;
  if (value.startsWith("/workspace/")) return join(workspace, value.slice("/workspace/".length));
  if (value === "/artifacts") return artifacts;
  if (value.startsWith("/artifacts/")) return join(artifacts, value.slice("/artifacts/".length));
  if (dependencies && value === "/dependencies") return dependencies;
  if (dependencies && value.startsWith("/dependencies/")) {
    return join(dependencies, value.slice("/dependencies/".length));
  }
  return value;
}

function statePath(name) {
  return join(stateDirectory, `${name}.json`);
}

function removeState(name) {
  rmSync(statePath(name), { force: true });
}

function readState(name) {
  const path = statePath(name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeState(name, state) {
  const existing = readState(name);
  writeFileSync(statePath(name), JSON.stringify({
    createdAt: existing?.createdAt ?? Date.now(),
    ...state,
  }), { mode: 0o600 });
}

function stopContainer(name) {
  const state = readState(name);
  if (!state) return false;
  if (Number.isSafeInteger(state.pid) && state.pid > 0) {
    const descendants = descendantPids(state.pid);
    for (const childPid of descendants.reverse()) safeKill(childPid);
    safeKill(state.pid);
  }
  writeState(name, { ...state, pid: null });
  return true;
}

function removeContainer(name) {
  const state = readState(name);
  if (!state) return false;
  stopContainer(name);
  if (state.artifacts) rmSync(state.artifacts, { recursive: true, force: true });
  removeState(name);
  return true;
}

function descendantPids(rootPid) {
  if (process.platform === "win32") return [];
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const result = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const [pid, ppid] of rows) {
      if (ppid === parent && !result.includes(pid)) {
        result.push(pid);
        pending.push(pid);
      }
    }
  }
  return result;
}

function safeKill(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited is the desired containment outcome.
  }
}

function trace(value) {
  const path = process.env.AGENT_LOOP_FAKE_OCI_TRACE;
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
}
