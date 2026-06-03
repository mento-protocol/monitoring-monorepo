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
      // Floors: measured 2026-06-03 (stmts 82.89 / branches 73.56 / funcs 81.76 / lines 84.99)
      // Threshold = floor(current) - 2 to absorb natural variance without ratcheting to 100%.
      thresholds: {
        statements: 80,
        branches: 71,
        functions: 79,
        lines: 82,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
