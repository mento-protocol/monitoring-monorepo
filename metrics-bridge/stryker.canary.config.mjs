// @ts-check

/**
 * Harness canary. It mutates a fixture whose every mutant its own test kills,
 * so `break: 100` fails only when Stryker stops activating mutants. Run it
 * before the real run in `stryker.config.mjs` to tell "harness broken" from
 * "tests weak". It reuses `vitest.mutation.config.ts`, so it proves the
 * harness for the exact runner and vitest configuration the real run uses.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: ["test/harness-canary/subject.ts"],
  // The runner reads this JSON report to reject a run with no mutants, which
  // scores NaN and clears every threshold. Its own file name keeps it away
  // from the real run's `reports/mutation/mutation.json`.
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/harness-canary.json" },
  tempDirName: ".stryker-tmp-canary",
  cleanTempDir: "always",
  thresholds: { high: 100, low: 100, break: 100 },
  ignorePatterns: ["coverage/**", "dist/**", "reports/**"],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
