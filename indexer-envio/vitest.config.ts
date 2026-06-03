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
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/handlers/**/*.ts"],
      // Floors: measured 2026-06-03 with Envio event-handler registration files
      // excluded. Handlers are exercised by integration tests, but their module
      // scope and framework callbacks are not meaningful global unit-coverage
      // inputs. Threshold = floor(current) - 2.
      thresholds: {
        statements: 70,
        branches: 62,
        functions: 76,
        lines: 72,
      },
    },
  },
});
