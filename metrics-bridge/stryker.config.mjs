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
    // score on `src/rebalance-probe.ts` drops below 85%. The CI workflow wires
    // this into the `bridge-rebalance-probe-baseline` job. The floor preserves
    // the documented two-point rounded-down safety margin; current evidence
    // and survivor classification live in `docs/mutation-testing.md`.
    break: 85,
  },
  ignorePatterns: ["coverage/**", "dist/**", "reports/**"],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
