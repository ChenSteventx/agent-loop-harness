import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeclarativeProjectAdapter,
  loadDeclarativeProjectConfig,
} from "../src/declarative-project.js";
import type { TaskSpec } from "../src/task-spec.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-loop-project-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "project.json");
  writeFileSync(path, content);
  return path;
}

const task: TaskSpec = {
  id: "DECL-1",
  goal: "prove declarative entry",
  acceptance: ["configured commands run"],
  risk: "low",
  verification: [
    { id: "shell-check", argv: ["sh", "-c", "true"] },
    { id: "node-check", argv: ["node", "check.mjs"] },
  ],
};

describe("declarative project entry", () => {
  it("loads a valid config and derives risk and commands from it", () => {
    const path = configFile(JSON.stringify({
      name: "python-service",
      policyVersion: "python-service/v1",
      sensitivePathSegments: ["payments/", "secrets"],
      rewriteNodeCommands: false,
    }));
    const adapter = new DeclarativeProjectAdapter(loadDeclarativeProjectConfig(path));
    expect(adapter.name).toBe("python-service");
    expect(adapter.policyVersion).toBe("python-service/v1");
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/payments/charge.py"] } })).toBe("high");
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/reports/render.py"] } })).toBe("low");
    // rewriteNodeCommands=false: argv passes through untouched for non-Node stacks.
    expect(adapter.verificationCommands(task).map((command) => command.argv[0])).toEqual(["sh", "node"]);
  });

  it("rewrites a leading node argv only when asked", () => {
    const adapter = new DeclarativeProjectAdapter({
      name: "node-service", policyVersion: "node-service/v1",
      sensitivePathSegments: [], rewriteNodeCommands: true,
    });
    const argv = adapter.verificationCommands(task).map((command) => command.argv[0]);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe(process.execPath);
  });

  it("fails closed on malformed, invalid, or over-permissive configs", () => {
    expect(() => loadDeclarativeProjectConfig(configFile("{not json")))
      .toThrow("unreadable or not JSON");
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({ name: " ", policyVersion: "v1" }))))
      .toThrow("Project config is invalid");
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({
      name: "x", policyVersion: "v1", gitAuthority: "mine",
    })))).toThrow("Project config is invalid");
  });
});
