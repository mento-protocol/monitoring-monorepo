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
function findFreePort() {
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

const needNextPort = !process.env.PLAYWRIGHT_NEXT_PORT;
const needFixturePort = !process.env.PLAYWRIGHT_FIXTURE_PORT;
if (needNextPort || needFixturePort) {
  // Allocate both simultaneously so the two servers can't be assigned the
  // same port (sequential allocation could reuse the first port after close).
  const [nextPort, fixturePort] = await Promise.all([
    findFreePort(),
    findFreePort(),
  ]);
  if (needNextPort) process.env.PLAYWRIGHT_NEXT_PORT = String(nextPort);
  if (needFixturePort)
    process.env.PLAYWRIGHT_FIXTURE_PORT = String(fixturePort);
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "playwright",
      ["test", "--config=playwright.config.ts", ...process.argv.slice(2)],
      {
        env: process.env,
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
try {
  exitCode = await runPlaywright();
} finally {
  if (originalNextEnv !== null) {
    await writeFile(nextEnvUrl, originalNextEnv);
  }
}

process.exit(exitCode);
