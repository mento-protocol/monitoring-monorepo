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
      ENVIO_START_BLOCK_ETHEREUM: "0",
      ENVIO_START_BLOCK_CELO_SEPOLIA: "0",
      ENVIO_START_BLOCK_MONAD_TESTNET: "0",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      // Floors = floor(measured) - 2, measured 2026-06-15.
      //
      // The ~12.4k lines under src/handlers/** were previously excluded from
      // coverage entirely — exercised end-to-end by the integration harness
      // (test/helpers/indexerTestHarness.ts) but invisible to every gate. They
      // are now included and gated two ways: the "src/handlers/**/*.ts" glob
      // bucket gives them a dedicated floor, and (since vitest also folds glob
      // files into the global pool) the global floors were re-measured over all
      // of src. Net effect: handlers go from ungated to ratcheted, and the
      // global gate now spans every source file rather than a hand-picked
      // subset. The handler floors are low because the harness drives common
      // paths, not rare-event branches — the bucket's job is visibility plus a
      // regression ratchet, not a high bar. Raising it is follow-up work.
      thresholds: {
        statements: 47,
        branches: 42,
        functions: 56,
        lines: 48,
        "src/handlers/**/*.ts": {
          statements: 22,
          branches: 14,
          functions: 29,
          lines: 22,
        },
        // Re-pins the pre-#925 non-handler floor so a coverage regression in
        // well-tested code (rpc.ts, pool.ts, helpers.ts, src/pool/**, src/rpc/**,
        // src/wormhole/**) isn't masked by low-coverage handler lines diluting
        // the global pool. Two globs are needed: picomatch's !(handlers) extglob
        // requires a child segment, so "src/!(handlers)/**/*.ts" covers non-handler
        // subdirs but silently misses direct children of src/. "src/*.ts" fills
        // that gap. Floors = floor(measured) - 2.
        "src/*.ts": {
          statements: 74,
          branches: 71,
          functions: 76,
          lines: 77,
        },
        "src/!(handlers)/**/*.ts": {
          statements: 65,
          branches: 52,
          functions: 75,
          lines: 66,
        },
      },
    },
  },
});
