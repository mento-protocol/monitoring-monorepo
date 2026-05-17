// @ts-check

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: ["src/rebalance-probe.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  cleanTempDir: "always",
  thresholds: {
    high: 90,
    low: 80,
    // Blocking gate: `pnpm bridge:mutation` exits non-zero when the mutation
    // score on `src/rebalance-probe.ts` drops below 80%. The CI workflow
    // wires this into the `bridge-rebalance-probe-baseline` job (see
    // `.github/workflows/mutation-testing.yml`). Current baseline: 83.94%
    // — see `docs/mutation-testing.md` for survivor classification.
    break: 80,
  },
  ignorePatterns: ["coverage/**", "dist/**", "reports/**"],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
