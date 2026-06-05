#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

// `next dev` rewrites this import to `.next/dev`, which would otherwise leave
// local browser-test runs with a dirty worktree.
const nextEnvUrl = new URL("../next-env.d.ts", import.meta.url);
const originalNextEnv = existsSync(nextEnvUrl)
  ? await readFile(nextEnvUrl, "utf8")
  : null;

// Bind two OS-assigned free ports for the Next dev server and the Hasura
// fixture server, then hand them to playwright.config.ts via the env vars it
// already reads. The fixed 3210/3211 defaults collide when a prior run's
// webServer outlives its own teardown and races the next run (e.g. the
// pre-push gate launching right after an interactive `pnpm test:browser`):
// `reuseExistingServer: false` makes Playwright hard-fail with
// "port is already used" instead of waiting. OS-assigned ports remove that
// fixed-port collision; a tiny TOCTOU window remains between close() here and
// Playwright's bind, but it no longer targets the same two ports every run.
// An explicit PLAYWRIGHT_*_PORT still wins.
function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Re-roll if the OS hands back a port we must avoid: an explicitly-set sibling,
// or the partner port assigned earlier in this pass. The collision is
// near-impossible (OS ephemeral range vs. a fixed low port) but cheap to rule
// out, and this is test infra whose whole job is removing flakes.
async function findFreePort(exclude = []) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocatePort();
    if (!exclude.includes(port)) return port;
  }
  throw new Error(`could not find a free port avoiding ${exclude.join(", ")}`);
}

const explicitNext = process.env.PLAYWRIGHT_NEXT_PORT;
const explicitFixture = process.env.PLAYWRIGHT_FIXTURE_PORT;
if (!explicitNext && !explicitFixture) {
  const nextPort = await findFreePort();
  process.env.PLAYWRIGHT_NEXT_PORT = String(nextPort);
  process.env.PLAYWRIGHT_FIXTURE_PORT = String(await findFreePort([nextPort]));
} else if (!explicitNext) {
  process.env.PLAYWRIGHT_NEXT_PORT = String(
    await findFreePort([Number(explicitFixture)]),
  );
} else if (!explicitFixture) {
  process.env.PLAYWRIGHT_FIXTURE_PORT = String(
    await findFreePort([Number(explicitNext)]),
  );
}

const args = process.argv.slice(2);
const productionIndex = args.indexOf("--production");
const production = productionIndex !== -1;
if (production) args.splice(productionIndex, 1);

const fixtureUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT}`;
const browserTestEnv = {
  ...process.env,
  NEXT_PUBLIC_HASURA_URL: `${fixtureUrl}/graphql`,
  NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
  NEXT_TELEMETRY_DISABLED: "1",
};

function runCommand(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(url, { child, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let childExitCode = null;
  child?.once("exit", (code) => {
    childExitCode = code ?? 1;
  });

  while (Date.now() < deadline) {
    if (childExitCode !== null) {
      throw new Error(
        `fixture server exited before becoming healthy (exit ${childExitCode})`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the server starts or the timeout expires.
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

async function startFixtureServerForProductionBuild() {
  const child = spawn(
    "node",
    [
      "tests/browser/fixtures/hasura-fixture-server.mjs",
      "--port",
      process.env.PLAYWRIGHT_FIXTURE_PORT,
    ],
    {
      env: browserTestEnv,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );

  await waitForUrl(`${fixtureUrl}/health`, { child });
  browserTestEnv.PLAYWRIGHT_REUSE_FIXTURE_SERVER = "true";
  return child;
}

async function buildProductionApp() {
  browserTestEnv.PLAYWRIGHT_NEXT_COMMAND =
    browserTestEnv.PLAYWRIGHT_NEXT_COMMAND ??
    "pnpm start --hostname 127.0.0.1 --port {port}";
  browserTestEnv.PLAYWRIGHT_NEXT_TIMEOUT_MS =
    process.env.PLAYWRIGHT_NEXT_START_TIMEOUT_MS ?? "120000";
  const code = await runCommand("pnpm", ["build"], { env: browserTestEnv });
  if (code !== 0) return code;
  return 0;
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "playwright",
      ["test", "--config=playwright.config.ts", ...args],
      {
        env: browserTestEnv,
        shell: process.platform === "win32",
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

let exitCode = 1;
let productionFixtureServer = null;
try {
  if (production) {
    productionFixtureServer = await startFixtureServerForProductionBuild();
    exitCode = await buildProductionApp();
  }
  if (exitCode === 0 || !production) {
    exitCode = await runPlaywright();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stopProcess(productionFixtureServer);
  if (originalNextEnv !== null) {
    await writeFile(nextEnvUrl, originalNextEnv);
  }
}

process.exit(exitCode);
