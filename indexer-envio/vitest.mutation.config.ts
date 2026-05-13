import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "test/code-quality-invariants.test.ts",
      "test/pool-helpers.test.ts",
      "test/tradingLimits.test.ts",
    ],
    env: {
      ENVIO_START_BLOCK_CELO: "0",
      ENVIO_START_BLOCK_MONAD: "0",
      ENVIO_START_BLOCK_CELO_SEPOLIA: "0",
      ENVIO_START_BLOCK_MONAD_TESTNET: "0",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/helpers.ts", "src/tradingLimits.ts"],
      exclude: ["test/**", "**/*.d.ts"],
    },
  },
});
