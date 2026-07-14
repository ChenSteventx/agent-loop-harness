import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explorerReportSchema } from "../src/explorer.js";
import {
  authorOutputSchema,
  defaultRoleOutputSchemas,
} from "../src/role-output-schemas.js";
import { reviewerOutputSchema } from "../src/reviewer.js";

const author = { summary: "implemented", changedFiles: ["src/a.ts"] };
const explorer = {
  relevantFiles: [{ path: "src/a.ts", symbols: ["a"] }],
  likelyAffectedTests: ["test/a.test.ts"],
  evidence: [{ path: "src/a.ts", observation: "a is called" }],
  importantUnknowns: [],
};
const reviewer = { findings: [] };

describe("runtime role output schemas", () => {
  it("keeps Author, Explorer, and Reviewer contracts strict and incompatible", () => {
    expect(authorOutputSchema.parse(author)).toEqual(author);
    expect(explorerReportSchema.parse(explorer)).toEqual(explorer);
    expect(reviewerOutputSchema.parse(reviewer)).toEqual(reviewer);
    expect(authorOutputSchema.safeParse(explorer).success).toBe(false);
    expect(explorerReportSchema.safeParse(reviewer).success).toBe(false);
    expect(reviewerOutputSchema.safeParse(author).success).toBe(false);
  });

  it("resolves three real JSON schemas outside the bootstrap automation directory", () => {
    const paths = defaultRoleOutputSchemas();
    expect(new Set(Object.values(paths)).size).toBe(3);
    for (const path of Object.values(paths)) {
      expect(existsSync(path)).toBe(true);
      expect(path).not.toContain("automation");
      const schema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
