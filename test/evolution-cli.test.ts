import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const loopCli = resolve("src/cli.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function cli(loopHome: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, loopCli, "--loop-home", loopHome, ...args], {
    cwd: resolve("."),
    env: { ...process.env, AGENT_LOOP_PROVIDER_PROFILE: "CODEX_PRIMARY" },
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Proves the evolution cycle is drivable from the CLI alone (no in-code seed
// scripts): the initial Champion and a custom-directory proposal — the two
// gaps that previously forced a tsx seed script — are now CLI commands.
describe("evolution cycle CLI completeness", () => {
  it("creates the initial Champion and refuses to clobber it", () => {
    const loopHome = temporaryDirectory("agent-loop-champion-init-");
    const created = cli(loopHome, ["config", "champion-init", "--project", "generic-node"]);
    expect(created.status, created.stderr).toBe(0);
    const champion = JSON.parse(created.stdout) as { id: string; projectScope: string; status: string };
    expect(champion).toMatchObject({ projectScope: "generic-node", status: "champion" });

    const again = cli(loopHome, ["config", "champion-init", "--project", "generic-node"]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("already has an active Champion");
  });

  it("honors --dataset-dir when creating a proposal", () => {
    const loopHome = temporaryDirectory("agent-loop-proposal-dir-");
    // In the real cycle a run has already created development state before a
    // proposal is authored; init establishes it for this isolated test.
    expect(cli(loopHome, ["init"]).status).toBe(0);
    expect(cli(loopHome, ["config", "champion-init", "--project", "generic-node"]).status).toBe(0);

    const base = ["proposal", "create", "--id", "cli-proposal", "--project", "generic-node",
      "--target", "retry-policy", "--patch", JSON.stringify({ retryLimit: 2 }),
      "--rationale", "prove the dataset-dir flag", "--source-facts", "fact-a", "--minimum-samples", "1"];

    // The repository eval/ directory holds proposal datasets: creation succeeds.
    const fromEval = cli(loopHome, [...base, "--dataset-dir", resolve("eval")]);
    expect(fromEval.status, fromEval.stderr).toBe(0);
    expect(JSON.parse(fromEval.stdout)).toMatchObject({ id: "cli-proposal", target: "retry-policy" });

    // An empty directory has no proposal datasets, so creation fails closed.
    const emptyDir = temporaryDirectory("agent-loop-empty-datasets-");
    const fromEmpty = cli(loopHome, ["proposal", "create", "--id", "cli-proposal-2", "--project", "generic-node",
      "--target", "retry-policy", "--patch", JSON.stringify({ retryLimit: 2 }),
      "--rationale", "empty dir must fail", "--source-facts", "fact-a", "--minimum-samples", "1",
      "--dataset-dir", emptyDir]);
    expect(fromEmpty.status).not.toBe(0);
  });
});
