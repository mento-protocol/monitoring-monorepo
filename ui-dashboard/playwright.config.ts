import { defineConfig, devices } from "@playwright/test";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const nextPort = Number(process.env.PLAYWRIGHT_NEXT_PORT ?? 3210);
const fixturePort = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 3211);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const nextUrl = `http://127.0.0.1:${nextPort}`;
// The fixture Hasura server listens on a fixed port baked into the build, so a
// healthy one left over from a prior run (or a sibling worktree) is safe to
// reuse rather than hard-fail on. Opt out with PLAYWRIGHT_REUSE_FIXTURE_SERVER=false.
const reuseFixtureServer =
  process.env.PLAYWRIGHT_REUSE_FIXTURE_SERVER !== "false";
// Browser tests serve a production `next build` via `next start` (the runner
// sets NEXT_DIST_DIR=.next-fixture), not a `next dev` server.
const nextCommand =
  process.env.PLAYWRIGHT_NEXT_COMMAND?.replaceAll("{port}", String(nextPort)) ??
  `pnpm exec next start --hostname 127.0.0.1 --port ${nextPort}`;
const nextTimeout = Number(process.env.PLAYWRIGHT_NEXT_TIMEOUT_MS ?? 120_000);
const fixedWeekendServerClock = pathToFileURL(
  resolve("tests/browser/fixtures/fixed-weekend-server-clock.mjs"),
).href;
const nextServerNodeOptions = [
  process.env.NODE_OPTIONS,
  `--import=${fixedWeekendServerClock}`,
]
  .filter(Boolean)
  .join(" ");

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

const forceSingleProcess =
  process.env.PLAYWRIGHT_FORCE_SINGLE_PROCESS === "true";
const inSandbox = detectSandbox() || forceSingleProcess;

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
  // Platform-neutral snapshot paths: drop the OS suffix so the same baselines
  // work on macOS (dev) and Linux (CI) without per-platform commits.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
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
      reuseExistingServer: reuseFixtureServer,
      timeout: 15_000,
    },
    {
      command: nextCommand,
      env: {
        NODE_OPTIONS: nextServerNodeOptions,
        // Serve the fixture build in `.next-fixture` (mirrors
        // FIXTURE_DIST_DIR in scripts/fixture-build.mjs).
        NEXT_DIST_DIR: ".next-fixture",
        NEXT_PUBLIC_HASURA_URL: `${fixtureUrl}/graphql`,
        NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: nextUrl,
      reuseExistingServer: false,
      timeout: nextTimeout,
    },
  ],
});
