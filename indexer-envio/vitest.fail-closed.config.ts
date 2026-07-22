import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    include: ["test/fixtures/failClosedSortedOracles.case.ts"],
    setupFiles: [
      "./vitest.hermetic-setup.ts",
      "./test/setup/publish-test-rpc.ts",
    ],
    env: {
      ENVIO_START_BLOCK_CELO: "0",
      ENVIO_START_BLOCK_MONAD: "0",
      ENVIO_START_BLOCK_CELO_SEPOLIA: "0",
      ENVIO_START_BLOCK_MONAD_TESTNET: "0",
    },
  },
});
