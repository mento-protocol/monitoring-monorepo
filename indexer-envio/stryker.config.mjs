// @ts-check

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: ["src/helpers.ts", "src/tradingLimits.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  cleanTempDir: "always",
  thresholds: {
    high: 90,
    low: 80,
    // Blocking gate: `pnpm indexer:mutation` exits non-zero when the
    // combined score across `src/helpers.ts` + `src/tradingLimits.ts`
    // drops below 92%. The CI workflow wires this into the
    // `indexer-logic-baseline` job (see
    // `.github/workflows/mutation-testing.yml`). Current baseline: 94.78%
    // with a 2-pt margin for measurement noise. All remaining survivors
    // are classified as equivalent mutants or accepted noise — see
    // `docs/mutation-testing.md` for the taxonomy.
    break: 92,
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
