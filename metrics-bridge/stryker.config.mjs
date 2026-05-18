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
    // score on `src/rebalance-probe.ts` drops below 86%. The CI workflow
    // wires this into the `bridge-rebalance-probe-baseline` job (see
    // `.github/workflows/mutation-testing.yml`). Current baseline: 88.32%
    // with 2-pt margin for noise. All remaining survivors are classified
    // as equivalent mutants or accepted test-scaffolding noise — see
    // `docs/mutation-testing.md` for the taxonomy.
    break: 86,
  },
  ignorePatterns: ["coverage/**", "dist/**", "reports/**"],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
