import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/cli.ts"],
      // Floors: measured 2026-06-03 (stmts 90.85 / branches 80.00 / funcs 97.33 / lines 92.40)
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 95,
        lines: 90,
      },
    },
  },
});
