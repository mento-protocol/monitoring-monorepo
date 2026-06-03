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
      ],
      thresholds: {
        statements: 76,
        branches: 70,
        functions: 76,
        lines: 76,
      },
    },
  },
});
