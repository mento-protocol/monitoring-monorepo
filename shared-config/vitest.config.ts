import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/*-abi.ts"],
      // Floors: measured 2026-05-18 (stmts 96.59 / branches 94.11 / funcs 100 / lines 100)
      // ABI files (erc20-abi.ts, rebalance-abi.ts) excluded — they are pure data
      // exports with no testable logic; covering them inflates 0% statement noise.
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 94,
        branches: 92,
        functions: 98,
        lines: 98,
      },
    },
  },
});
