import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const loopCli = resolve("src/cli.ts");
const fakeCodex = resolve("test/fixtures/fake-codex.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; taskPath: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-production-target-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "production@example.invalid"]);
  git(root, ["config", "user.name", "Production Test"]);
  writeFileSync(
    join(root, "check.mjs"),
    "import { readFileSync } from 'node:fs'; process.exit(readFileSync('changed.txt', 'utf8').includes('production CLI') ? 0 : 5);\n",
  );
  const taskPath = join(root, "task.yaml");
  writeFileSync(taskPath, [
    "id: PRODUCTION-CLI-1",
    "goal: Prove the public CLI executes the bounded loop",
    "acceptance:",
    "  - changed.txt is created by the Author and committed by the Harness",
    "risk: low",
    "verification:",
    "  - id: production-check",
    "    argv: [node, check.mjs]",
    "",
  ].join("\n"));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { root, taskPath };
}

function runCli(args: string[], environment: NodeJS.ProcessEnv): unknown {
  const result = spawnSync(process.execPath, [tsxCli, loopCli, ...args], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("production CLI loop", () => {
  it("runs the public CODEX_PRIMARY entry point and reloads its durable ready state", () => {
    const target = fixture();
    const loopHome = mkdtempSync(join(tmpdir(), "agent-loop-production-home-"));
    temporaryDirectories.push(loopHome);
    const runId = "production-cli-smoke";
    const environment = {
      ...process.env,
      CODEX_BIN: fakeCodex,
      FAKE_CODEX_MODE: "production-author",
      AGENT_LOOP_PROVIDER_PROFILE: "CODEX_PRIMARY",
    };

    const started = runCli([
      "--loop-home", loopHome,
      "--provider-profile", "CODEX_PRIMARY",
      "run",
      "--run-id", runId,
      "--task", target.taskPath,
      "--repository", target.root,
    ], environment) as {
      run: { status: string; binding: { providerProfile: string } };
      worktreePath: string;
      evidence: Array<{ kind: string; status: string }>;
      invocationManifests: Array<{
        role: string;
        prompt: { renderedPromptHash: string; redactedArtifactPath: string | null };
        provider: { actualProvider: string };
      }>;
    };

    expect(started.run).toMatchObject({ status: "ready", binding: { providerProfile: "CODEX_PRIMARY" } });
    expect(started.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "candidate_commit", status: "valid" }),
      expect.objectContaining({ kind: "command", status: "valid" }),
    ]));
    expect(started.invocationManifests).toEqual([
      expect.objectContaining({
        role: "author",
        prompt: expect.objectContaining({
          renderedPromptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          redactedArtifactPath: null,
        }),
        provider: expect.objectContaining({ actualProvider: "openai-codex" }),
      }),
    ]);
    expect(readFileSync(join(started.worktreePath, "changed.txt"), "utf8")).toContain("production CLI");
    expect(git(started.worktreePath, ["show", "-s", "--format=%an <%ae>"])).toBe(
      "Agent Loop Harness <agent-loop@localhost>",
    );
    expect(git(target.root, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(existsSync(join(target.root, "changed.txt"))).toBe(false);

    const reloaded = runCli([
      "--loop-home", loopHome,
      "--provider-profile", "CODEX_PRIMARY",
      "status",
      "--run-id", runId,
    ], environment) as { run: { status: string }; worktreePath: string };
    expect(reloaded).toMatchObject({ run: { status: "ready" }, worktreePath: started.worktreePath });
  }, 180_000);
});
