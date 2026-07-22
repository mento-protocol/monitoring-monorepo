#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { buildFixtureApp, fixtureBuildExists } from "./fixture-build.mjs";
import {
  FIXTURE_DIST_DIR,
  FIXTURE_HASURA_PORT,
  FIXTURE_HASURA_URL,
} from "./fixture-constants.mjs";

// Browser tests run against a production `next build` (fixture mode) served by
// `next start`, never a `next dev` server. The build lives in `.next-fixture`
// and is produced at most once per gate run: the turbo `test:browser` task
// `dependsOn` the cached `fixture-build` task, so when invoked through turbo
// the build already exists here and is reused. Direct callers (CI's
// `test:browser`, `test:browser:update-snapshots`, a bare local run) build it
// in-script when it is absent. `--production` forces a rebuild.
//
// Only the Next server port is OS-assigned (bound at runtime, not inlined). The
// fixture Hasura port is fixed (`FIXTURE_HASURA_PORT`) because it is baked into
// the client bundle and CSP; Playwright reuses an already-running fixture
// server on it (`reuseExistingServer: true`) instead of hard-failing.
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

async function findFreePort(exclude = []) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocatePort();
    if (!exclude.includes(port)) return port;
  }
  throw new Error(`could not find a free port avoiding ${exclude.join(", ")}`);
}

// The fixture Hasura port is fixed, not env-overridable: it's inlined into
// the client bundle at build time (see fixture-build.mjs), so the server
// must answer on the exact port the build baked in. A caller-supplied value
// here would desync the two and either point the client at nothing or, worse,
// an unrelated reused server. The var stays settable for turbo's cache-key
// tracking; it just can't diverge from the build's constant.
process.env.PLAYWRIGHT_FIXTURE_PORT = String(FIXTURE_HASURA_PORT);
if (!process.env.PLAYWRIGHT_NEXT_PORT) {
  process.env.PLAYWRIGHT_NEXT_PORT = String(
    await findFreePort([FIXTURE_HASURA_PORT]),
  );
}

const args = process.argv.slice(2);
const productionIndex = args.indexOf("--production");
const forceRebuild = productionIndex !== -1;
if (forceRebuild) args.splice(productionIndex, 1);
// Captured before browserTestEnv defaults PLAYWRIGHT_NEXT_COMMAND below, so
// this reflects only an explicit caller override (e.g. the documented
// Turbopack-production-build-panic fallback to `pnpm dev --webpack`).
const usingCustomNextCommand = Boolean(process.env.PLAYWRIGHT_NEXT_COMMAND);

const browserTestEnv = {
  ...process.env,
  NEXT_DIST_DIR: FIXTURE_DIST_DIR,
  NEXT_PUBLIC_HASURA_URL: FIXTURE_HASURA_URL,
  NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  PLAYWRIGHT_NEXT_COMMAND:
    process.env.PLAYWRIGHT_NEXT_COMMAND ??
    "pnpm exec next start --hostname 127.0.0.1 --port {port}",
  PLAYWRIGHT_NEXT_TIMEOUT_MS:
    process.env.PLAYWRIGHT_NEXT_TIMEOUT_MS ?? "120000",
};

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
try {
  if (usingCustomNextCommand) {
    // A custom Next command doesn't serve the fixture build (it's the
    // documented fallback for a Turbopack production-build panic in
    // buildFixtureApp() — see docs/notes/dashboard-verification.md). Building
    // here would hard-fail on that same panic before Playwright ever starts
    // the substitute command, defeating the fallback entirely.
    exitCode = 0;
  } else if (forceRebuild || !fixtureBuildExists()) {
    exitCode = await buildFixtureApp();
  } else {
    exitCode = 0;
  }
  if (exitCode === 0) {
    exitCode = await runPlaywright();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
}

process.exit(exitCode);
