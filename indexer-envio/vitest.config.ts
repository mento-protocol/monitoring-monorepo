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
  },
});
