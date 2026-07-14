import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("generic architecture boundary", () => {
  it("contains no external project imports, absolute workspace paths, or hidden placeholders", () => {
    const files = sourceFiles(resolve("src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/[A-Z]:[\\/](?:ctx|Users)[\\/]/iu);
      expect(source, file).not.toMatch(/\b(?:TODO|FIXME|PLACEHOLDER)\b/iu);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
        expect(match[1], `${file} imports outside src`).not.toMatch(/^\.\.\//u);
      }
    }
  });
});
