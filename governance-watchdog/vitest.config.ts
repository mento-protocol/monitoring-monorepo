import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      // Floors measured 2026-06-15 after adding delivery-path tests.
      // Threshold = floor(current) - 2, matching indexer-envio/vitest.config.ts.
      thresholds: {
        statements: 83,
        branches: 73,
        functions: 88,
        lines: 83,
      },
    },
  },
});
