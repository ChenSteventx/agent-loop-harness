import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Child-process and SQLite-heavy suites contend badly on mounted
    // workspaces; one worker keeps the existing per-test timeouts meaningful.
    maxWorkers: 1,
  },
});
