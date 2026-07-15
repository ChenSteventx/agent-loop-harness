import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("generic architecture boundary", () => {
  it("contains no external project imports, absolute workspace paths, or hidden placeholders", () => {
    const sourceRoot = resolve("src");
    const files = sourceFiles(sourceRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/[A-Z]:[\\/](?:ctx|Users)[\\/]/iu);
      expect(source, file).not.toMatch(/\b(?:TODO|FIXME|PLACEHOLDER)\b/iu);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
        const specifier = match[1];
        if (specifier?.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          expect(relative(sourceRoot, target), `${file} imports outside src`).not.toMatch(/^\.\.(?:[\\/]|$)/u);
        }
      }
    }
  });

  it("keeps evaluation, memory, and evolution sidecars unable to mutate formal Run state", () => {
    const sidecarRoots = [resolve("src/evaluation"), resolve("src/memory"), resolve("src/evolution")];
    const forbidden = [
      /from\s+["'][^"']*orchestrator(?:\.js)?["']/u,
      /\bOrchestrator\b/u,
      /\btransitionRun\s*\(/u,
      /\bresumeRun\s*\(/u,
      /\breopenRunForInvalidEvidence\s*\(/u,
      /\binstallEvidence\s*\(/u,
      /\bcommitCandidate\s*\(/u,
      /\bmarkMerged\s*\(/u,
    ];
    for (const file of sidecarRoots.flatMap(sourceFiles)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) expect(source, `${file} violates the sidecar boundary`).not.toMatch(pattern);
    }
  });
});
