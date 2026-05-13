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
    break: null,
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
