import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Vitest's default is 5 s. Tests that spawn real processes (git, npm via
    // cmd.exe) also set their own explicit timeout from test/helpers.ts; this
    // is the baseline for in-process tests and for slow Windows git spawns.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
