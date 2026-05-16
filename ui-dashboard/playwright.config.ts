import { defineConfig, devices } from "@playwright/test";
import { unlinkSync, writeFileSync } from "node:fs";

const nextPort = Number(process.env.PLAYWRIGHT_NEXT_PORT ?? 3210);
const fixturePort = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 3211);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const nextUrl = `http://127.0.0.1:${nextPort}`;

/**
 * Probe the active Claude Code bash sandbox by attempting a write to /tmp,
 * which sits outside the sandbox's write-allow list (only `/tmp/claude`,
 * `$TMPDIR`, and a handful of repo paths are writable). A non-sandboxed
 * process — CI, a regular Terminal, or a Claude session that has
 * whitelisted this command via `sandbox.excludedCommands` — writes
 * successfully and cleans up. A sandboxed process throws EPERM.
 *
 * Why not the `CLAUDE_SANDBOX` env var: it's a stale shell setting once the
 * user enables `sandbox.allowUnsandboxedCommands` + a matching exclusion;
 * the env var stays set in the shell profile but the sandbox is actually
 * lifted, leaving the chromium `--single-process` workaround active where
 * it shouldn't be (and that's the workaround that makes sequential tests
 * flaky in single-process mode).
 */
function detectSandbox(): boolean {
  const probe = `/tmp/playwright-sandbox-probe-${process.pid}`;
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return false;
  } catch {
    return true;
  }
}

const inSandbox = detectSandbox();

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.test.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  // `--single-process` chromium (required in macOS sandbox — see launchOptions
  // below) is flaky across sequential tests: contexts can leave the shared
  // process in a state where the next `browser.newContext()` hits
  // "Target page, context or browser has been closed". The tests pass in
  // isolation and in CI's full multi-process chromium; two retries cover the
  // sandbox flake without papering over real regressions (the gate still
  // fails if all attempts miss). CI runs with retries=0 — flake there is
  // a regression signal.
  retries: inSandbox ? 2 : 0,
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
      args: inSandbox ? ["--single-process"] : [],
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
