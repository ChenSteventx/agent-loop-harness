import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandRunner,
  commandReceiptProvesSuccess,
} from "../src/execution.js";
import type { CommandRequest } from "../src/execution.js";

const enabled = process.env.AGENT_LOOP_REAL_OCI_TEST === "1";
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function repository(files: Readonly<Record<string, string>>): string {
  const root = temporaryDirectory("agent-loop-real-oci-repo-");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "agent-loop@example.invalid"]);
  git(root, ["config", "user.name", "Agent Loop Test"]);
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "real OCI fixture"]);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function artifacts(label: string): string {
  return join(temporaryDirectory("agent-loop-real-oci-artifacts-"), label);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(enabled)("CommandRunner with a real OCI runtime", () => {
  it("denies a host sentinel and a workspace write while producing an authoritative receipt", async () => {
    const sentinelDirectory = temporaryDirectory("agent-loop-host-sentinel-");
    const sentinel = join(sentinelDirectory, "must-not-be-visible.txt");
    writeFileSync(sentinel, "host secret fixture\n");
    const root = repository({
      "tracked.txt": "unchanged\n",
      "verify.mjs": [
        "import fs from 'node:fs';",
        "let hostDenied = false;",
        "let workspaceDenied = false;",
        "try { fs.readFileSync(process.env.HOST_SENTINEL); } catch { hostDenied = true; }",
        "try { fs.writeFileSync('tracked.txt', 'changed\\n'); } catch { workspaceDenied = true; }",
        "if (!hostDenied || !workspaceDenied) process.exit(23);",
      ].join("\n"),
    });
    const runner = new CommandRunner();
    const request: CommandRequest = {
      argv: ["node", "verify.mjs"],
      cwd: root,
      artifactDirectory: artifacts("isolation"),
      environmentAllowlist: ["HOST_SENTINEL"],
      environment: { HOST_SENTINEL: sentinel },
      policyVersion: "real-oci-test/v1",
      configurationHash: "a".repeat(64),
    };
    const expectation = runner.receiptExpectation(request);
    const result = await runner.run(request);
    expect(commandReceiptProvesSuccess(result, expectation)).toBe(true);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("unchanged\n");
  }, 30_000);

  it("kills a detached descendant with the timed-out container", async () => {
    const root = repository({ "tracked.txt": "unchanged\n" });
    const artifactRoot = artifacts("process-tree");
    const result = await new CommandRunner().run({
      argv: ["node", "-e", [
        "const {spawn}=require('node:child_process')",
        "const code=\"setTimeout(()=>require('node:fs').writeFileSync('/artifacts/late.txt','late'),1200)\"",
        "spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}).unref()",
        "setInterval(()=>{},1000)",
      ].join(";")],
      cwd: root,
      artifactDirectory: artifactRoot,
      timeoutMs: 100,
      terminationGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.containmentOutcome).toBe("killed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    expect(readdirSync(artifactRoot, { recursive: true }).some((path) => String(path).endsWith("late.txt"))).toBe(false);
  }, 30_000);
});
