import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeclarativeProjectAdapter,
  loadDeclarativeProjectConfig,
} from "../src/declarative-project.js";
import type { TaskSpec } from "../src/task-spec.js";
import { fakeOciImage } from "./oci-fixture.js";

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
      verificationImage: fakeOciImage,
      sensitivePathSegments: ["payments/", "secrets"],
      rewriteNodeCommands: false,
    }));
    const adapter = new DeclarativeProjectAdapter(loadDeclarativeProjectConfig(path));
    expect(adapter.name).toBe("python-service");
    // Content-addressed: declared version plus a hash of the whole config.
    expect(adapter.policyVersion).toMatch(/^python-service\/v1#[0-9a-f]{12}$/u);
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/payments/charge.py"] } })).toBe("high");
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/reports/render.py"] } })).toBe("low");
    // rewriteNodeCommands=false: argv passes through untouched for non-Node stacks.
    expect(adapter.verificationCommands(task).map((command) => command.argv[0])).toEqual(["sh", "node"]);
  });

  it("rewrites a leading node argv only when asked", () => {
    const adapter = new DeclarativeProjectAdapter({
      name: "node-service", policyVersion: "node-service/v1",
      verificationImage: fakeOciImage,
      sensitivePathSegments: [], rewriteNodeCommands: true,
    });
    const argv = adapter.verificationCommands(task).map((command) => command.argv[0]);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("node");
  });

  it("binds the policy version to the config content, not just the declared string", () => {
    const base = {
      name: "svc", policyVersion: "svc/v1", verificationImage: fakeOciImage, rewriteNodeCommands: false,
    };
    const strict = new DeclarativeProjectAdapter(loadDeclarativeProjectConfig(
      configFile(JSON.stringify({ ...base, sensitivePathSegments: ["deploy/"] }))));
    const loosened = new DeclarativeProjectAdapter(loadDeclarativeProjectConfig(
      configFile(JSON.stringify({ ...base, sensitivePathSegments: [] }))));
    const identical = new DeclarativeProjectAdapter(loadDeclarativeProjectConfig(
      configFile(JSON.stringify({ ...base, sensitivePathSegments: ["deploy/"] }))));
    // Same declared version with weakened segments must not look like the
    // same policy to the resume-time drift gate; identical content must.
    expect(loosened.policyVersion).not.toBe(strict.policyVersion);
    expect(identical.policyVersion).toBe(strict.policyVersion);
  });

  it("matches sensitive segments across Unicode normalization forms", () => {
    const adapter = new DeclarativeProjectAdapter({
      name: "svc", policyVersion: "svc/v1",
      verificationImage: fakeOciImage,
      sensitivePathSegments: ["s\u00e9curit\u00e9/"], rewriteNodeCommands: false,
    });
    // Git often emits NFD; the config author typically types NFC.
    expect(adapter.minimumRisk({ task: { ...task, scope: ["src/se\u0301curite\u0301/keys.py"] } })).toBe("high");
  });

  it("fails closed on malformed, invalid, or over-permissive configs", () => {
    expect(() => loadDeclarativeProjectConfig(configFile("{not json")))
      .toThrow("unreadable or not JSON");
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({ name: " ", policyVersion: "v1" }))))
      .toThrow("Project config is invalid");
    // Omitting sensitivePathSegments is invalid — "nothing sensitive" must be an explicit [].
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({ name: "x", policyVersion: "v1" }))))
      .toThrow("sensitivePathSegments");
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({
      name: "x", policyVersion: "v1", sensitivePathSegments: [], verificationImage: "node:latest",
    })))).toThrow("immutable repository reference");
    expect(() => loadDeclarativeProjectConfig(configFile(JSON.stringify({
      name: "x", policyVersion: "v1", verificationImage: fakeOciImage,
      sensitivePathSegments: [], gitAuthority: "mine",
    })))).toThrow("Project config is invalid");
  });
});
