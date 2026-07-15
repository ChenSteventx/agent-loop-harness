import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("continuous runner Codex CLI compatibility", () => {
  it("uses the supported config override instead of the removed approval flag", () => {
    const source = readFileSync(resolve("automation/continue.mjs"), "utf8");
    expect(source).not.toContain("--ask-for-approval");
    expect(source).toContain('approval_policy="never"');
    expect(source).toContain("--ignore-user-config");
    expect(source).toContain('windows.sandbox="${windowsSandbox}"');
  });

  it("uses a strict output schema accepted by Codex", () => {
    const schema = JSON.parse(
      readFileSync(resolve("automation/report.schema.json"), "utf8"),
    ) as JsonSchema;

    expectStrictObjectSchemas(schema);
    expect(schema.properties?.status?.enum).toContain(
      "external_verification_required",
    );
  });

  it("keeps external verification fallback opt-in and fail-closed", async () => {
    const policy = await loadExternalVerificationPolicy();
    const deferredReport = {
      status: policy.EXTERNAL_VERIFICATION_STATUS,
      commands: [
        {
          command: "npm test",
          exit_code: 1,
          result: "spawnSync git EPERM",
        },
      ],
      not_verified: ["npm test could not run inside the managed sandbox"],
    };

    expect(policy.parseExternalVerificationFallback(undefined)).toBe(false);
    expect(policy.parseExternalVerificationFallback("0")).toBe(false);
    expect(policy.parseExternalVerificationFallback("1")).toBe(true);
    expect(() => policy.parseExternalVerificationFallback("yes")).toThrow(
      "must be one of",
    );
    expect(
      policy.validateExternalVerificationDeferral(deferredReport, false),
    ).toContain("disabled");
    expect(
      policy.validateExternalVerificationDeferral(deferredReport, true),
    ).toBeNull();
    expect(
      policy.validateExternalVerificationDeferral(
        { ...deferredReport, commands: [{ exit_code: 0 }] },
        true,
      ),
    ).toContain("failed or unavailable command");
    expect(
      policy.validateExternalVerificationDeferral(
        { ...deferredReport, not_verified: [] },
        true,
      ),
    ).toContain("not_verified");
  });

  it("routes a valid deferral into deterministic manifest verification", () => {
    const source = readFileSync(resolve("automation/continue.mjs"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(source).toContain(
      "validateExternalVerificationDeferral(\n        report,",
    );
    expect(source).toContain(
      "const verification = runVerification(card, result.runDir);",
    );
    expect(source.indexOf("validateExternalVerificationDeferral(")).toBeLessThan(
      source.indexOf("const verification = runVerification(card, result.runDir);"),
    );
  });
});

interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
}

interface ExternalVerificationPolicy {
  EXTERNAL_VERIFICATION_STATUS: string;
  parseExternalVerificationFallback(value: string | undefined): boolean;
  validateExternalVerificationDeferral(
    report: {
      status: string;
      commands: Array<{ exit_code: number | null }>;
      not_verified: string[];
    },
    enabled: boolean,
  ): string | null;
}

async function loadExternalVerificationPolicy(): Promise<ExternalVerificationPolicy> {
  const url = pathToFileURL(
    resolve("automation/external-verification-policy.mjs"),
  ).href;
  return (await import(url)) as ExternalVerificationPolicy;
}

function expectStrictObjectSchemas(schema: JsonSchema): void {
  if (schema.type === "object") {
    expect(new Set(schema.required ?? [])).toEqual(
      new Set(Object.keys(schema.properties ?? {})),
    );
  }

  for (const child of Object.values(schema.properties ?? {})) {
    expectStrictObjectSchemas(child);
  }
  if (schema.items) expectStrictObjectSchemas(schema.items);
}
