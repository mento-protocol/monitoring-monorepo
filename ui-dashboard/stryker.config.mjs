// @ts-check

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: ["src/lib/weekend.ts", "src/lib/pool-id.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  cleanTempDir: "always",
  thresholds: {
    high: 90,
    low: 80,
    // Blocking gate: `pnpm dashboard:mutation` exits non-zero when the
    // combined score across `src/lib/weekend.ts` + `src/lib/pool-id.ts`
    // drops below 86%. The CI workflow wires this into the
    // `dashboard-logic-baseline` job (see
    // `.github/workflows/mutation-testing.yml`). Current baseline: 88.81%
    // with a 2-pt margin for measurement noise. All remaining survivors
    // are classified as equivalent mutants or accepted noise — see
    // `docs/mutation-testing.md` for the taxonomy.
    break: 86,
  },
  ignorePatterns: [
    ".next/**",
    "coverage/**",
    "dist/**",
    "reports/**",
    "src/lib/__generated__/**",
    "src/lib/queries/**",
  ],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
};

export default config;
