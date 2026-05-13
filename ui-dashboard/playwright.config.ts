import { defineConfig, devices } from "@playwright/test";

const nextPort = Number(process.env.PLAYWRIGHT_NEXT_PORT ?? 3210);
const fixturePort = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 3211);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const nextUrl = `http://127.0.0.1:${nextPort}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.test.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: nextUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node tests/browser/fixtures/hasura-fixture-server.mjs --port ${fixturePort}`,
      url: `${fixtureUrl}/health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `pnpm dev --hostname 127.0.0.1 --port ${nextPort}`,
      env: {
        NEXT_PUBLIC_HASURA_URL: `${fixtureUrl}/graphql`,
        NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: nextUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
