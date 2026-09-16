import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.hermetic-setup.ts"],
    environment: "node",
    include: [
      "test/rebalance-probe.test.ts",
      "test/harness-canary/subject.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/rebalance-probe.ts"],
    },
  },
});
