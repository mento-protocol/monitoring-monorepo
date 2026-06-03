import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/*.d.ts",
        "scripts/",
      ],
      // Floors: measured 2026-06-03 after focused handler hardening tests
      // (stmts 80.51 / branches 71.45 / funcs 84.68 / lines 80.70).
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 78,
        branches: 69,
        functions: 82,
        lines: 78,
      },
    },
  },
});
