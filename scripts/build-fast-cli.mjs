import { build } from "esbuild";

await build({
  entryPoints: ["src/cli-fast-entry.ts"],
  outfile: "dist/cli-fast.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join(" "),
  },
});
