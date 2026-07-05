import { defineConfig } from "vitest/config";

const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const COVERAGE_TEST_TIMEOUT_MS = 120_000;
const isCoverageRun = process.argv.includes("--coverage");

export default defineConfig({
  test: {
    globals: true,
    // V8 coverage instrumentation can push a few generated-handler integration
    // tests past 60s under the repo quality-gate wrapper. Keep normal tests
    // strict while giving coverage-only runs enough room to report assertions.
    testTimeout: isCoverageRun
      ? COVERAGE_TEST_TIMEOUT_MS
      : DEFAULT_TEST_TIMEOUT_MS,
    include: ["test/**/*.test.ts"],
    setupFiles: [
      "./vitest.hermetic-setup.ts",
      "./test/setup/publish-test-rpc.ts",
    ],
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
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        // Reserve-yield has a dedicated chain-1 config and regression command.
        // Keep it out of the default primary-indexer coverage pool until the
        // hosted replay proof closes #1017.
        "src/handlers/susdsEvents.ts",
        "src/handlers/susds/**/*.ts",
        "src/handlers/steth.ts",
        "src/handlers/steth/**/*.ts",
        "src/rpc/susds.ts",
      ],
      // Floors = floor(measured) - 2, measured 2026-07-05, after the
      // must-cover scenario-test wave (#1052, #1053, #1054) landed on main.
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
        statements: 49,
        branches: 44,
        functions: 59,
        lines: 50,
        "src/handlers/**/*.ts": {
          statements: 24,
          branches: 18,
          functions: 32,
          lines: 24,
        },
        // Re-pins the pre-#925 non-handler floor so a coverage regression in
        // well-tested code (rpc.ts, pool.ts, helpers.ts, src/pool/**, src/rpc/**,
        // src/wormhole/**) isn't masked by low-coverage handler lines diluting
        // the global pool. Two globs are needed: picomatch's !(handlers) extglob
        // requires a child segment, so "src/!(handlers)/**/*.ts" covers non-handler
        // subdirs but silently misses direct children of src/. "src/*.ts" fills
        // that gap. Floors = floor(measured) - 2, measured 2026-07-05.
        "src/*.ts": {
          statements: 76,
          branches: 72,
          functions: 79,
          lines: 79,
        },
        "src/!(handlers)/**/*.ts": {
          statements: 67,
          branches: 54,
          functions: 75,
          lines: 69,
        },
      },
    },
  },
});
