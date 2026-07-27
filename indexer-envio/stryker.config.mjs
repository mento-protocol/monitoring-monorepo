// @ts-check

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: [
    "src/helpers.ts",
    "src/tradingLimits.ts",
    "src/handlers/stables/classifyKind.ts",
    "src/handlers/stables/dailyFlush.ts",
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  // Keep Stryker's sandbox outside the package root so package lint can run in
  // parallel without scanning transient `.stryker-tmp/sandbox-*` files.
  tempDirName: "../.stryker-tmp/indexer-envio",
  cleanTempDir: "always",
  thresholds: {
    high: 90,
    low: 80,
    // Blocking gate: `pnpm indexer:mutation` exits non-zero when the
    // combined score across `src/helpers.ts`, `src/tradingLimits.ts`, and the
    // stables handler helpers drops below 94%. The CI workflow wires this into
    // the indexer baseline job. The floor preserves the documented two-point
    // rounded-down safety margin; current evidence and survivor classification
    // live in `docs/mutation-testing.md`.
    break: 94,
  },
  ignorePatterns: [
    ".envio/**",
    "coverage/**",
    "dist/**",
    "generated/**",
    "reports/**",
  ],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
