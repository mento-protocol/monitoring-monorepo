import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
    exclude: [...configDefaults.exclude, "tests/browser/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      // Floors: measured 2026-05-18 (stmts 74.14 / branches 66.64 / funcs 70.22 / lines 75.93)
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 72,
        branches: 64,
        functions: 68,
        lines: 73,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
