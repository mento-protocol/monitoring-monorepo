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
    // Inside Claude Code's macOS sandbox, Chromium can't register Mach ports
    // for its multi-process IPC (Seatbelt blocks `bootstrap_check_in`).
    // `--single-process` collapses renderer/network/GPU into one process and
    // sidesteps the Mach IPC entirely. CI and regular Terminal runs get the
    // normal multi-process model for full test fidelity.
    launchOptions: {
      args: process.env.CLAUDE_SANDBOX === "1" ? ["--single-process"] : [],
    },
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
