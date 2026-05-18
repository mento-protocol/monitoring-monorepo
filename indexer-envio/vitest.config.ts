import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    env: {
      // Lower start_blocks so test simulations can use small block numbers
      // without violating the config's mainnet start_block invariants.
      ENVIO_START_BLOCK_CELO: "0",
      ENVIO_START_BLOCK_MONAD: "0",
      ENVIO_START_BLOCK_CELO_SEPOLIA: "0",
      ENVIO_START_BLOCK_MONAD_TESTNET: "0",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      // Floors: measured 2026-05-18 (stmts 46.96 / branches 39.87 / funcs 58.47 / lines 47.65)
      // Low numbers reflect untested Envio event handlers (src/handlers/**) which
      // are runtime-only and not unit-testable. Threshold = floor(current) - 2.
      thresholds: {
        statements: 44,
        branches: 37,
        functions: 56,
        lines: 45,
      },
    },
  },
});
