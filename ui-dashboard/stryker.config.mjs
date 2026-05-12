// @ts-check

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  mutate: ["src/lib/weekend.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: {
    high: 90,
    low: 80,
    break: null,
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
