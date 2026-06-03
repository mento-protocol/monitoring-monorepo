import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      // Floors: measured 2026-06-03 (stmts 91.69 / branches 85.50 / funcs 89.69 / lines 94.31)
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 89,
        branches: 83,
        functions: 87,
        lines: 92,
      },
    },
  },
});
