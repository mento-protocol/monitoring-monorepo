#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DIST_DIR, FIXTURE_HASURA_URL } from "./fixture-constants.mjs";
import {
  currentFixtureBuildHash,
  invalidateFixtureBuildIdentity,
  writeFixtureBuildIdentity,
} from "./fixture-identity.mjs";

// `next build` rewrites these tracked files to reference the active `distDir`
// (`next-env.d.ts` imports `<distDir>/types`; `tsconfig.json` adds
// `<distDir>/types/**` to `include`). With the fixture `distDir` that would
// dirty the worktree and change turbo inputs (busting the build cache on the
// next run), so snapshot and restore them around the build.
const rewrittenTrackedFiles = ["../next-env.d.ts", "../tsconfig.json"].map(
  (relative) => new URL(relative, import.meta.url),
);
function runNextBuild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["build"], {
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Produce the fixture-mode production build in `.next-fixture`. */
export async function buildFixtureApp({
  fixtureBuildHash,
  distDir,
  runBuild = runNextBuild,
} = {}) {
  const expectedHash =
    fixtureBuildHash ??
    process.env.TURBO_HASH ??
    (await currentFixtureBuildHash());
  const snapshots = await Promise.all(
    rewrittenTrackedFiles.map(async (url) => ({
      url,
      original: existsSync(url) ? await readFile(url, "utf8") : null,
    })),
  );
  try {
    // A failed or interrupted build may leave old/partial dist output. Remove
    // its authority marker first so the next direct run must rebuild.
    await invalidateFixtureBuildIdentity(distDir);
    const exitCode = await runBuild({
      ...process.env,
      NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
      NEXT_PUBLIC_HASURA_URL: FIXTURE_HASURA_URL,
      NEXT_DIST_DIR: distDir ?? FIXTURE_DIST_DIR,
      NEXT_TELEMETRY_DISABLED: "1",
    });
    if (exitCode === 0) {
      await writeFixtureBuildIdentity(expectedHash, distDir);
    }
    return exitCode;
  } finally {
    await Promise.all(
      snapshots.map(({ url, original }) =>
        original === null ? undefined : writeFile(url, original),
      ),
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(await buildFixtureApp());
}
