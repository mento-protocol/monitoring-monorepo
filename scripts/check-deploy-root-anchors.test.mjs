#!/usr/bin/env node
/**
 * Static regression checks for deploy scripts that source deploy-guard.sh.
 *
 * The guard validates the repository that contains the guard file. These
 * scripts must then run git/build/deploy commands from that same repo root so
 * an absolute-path invocation from another checkout cannot deploy foreign CWD
 * artifacts after the monitoring-monorepo guard has passed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The guard itself is not a wrapper. Exclude it by path so a future comment in
// it that quotes its own path cannot pull it into the subject list.
const GUARD_PATH = "scripts/lib/deploy-guard.sh";

const orderedAnchors = {
  "scripts/deploy-dashboard.sh": [
    'REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    '(cd "$REPO_ROOT" && vercel deploy --prod',
  ],
  "scripts/deploy-indexer.sh": [
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    'REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"',
    'cd "$REPO_ROOT"',
    "git ls-remote --heads origin",
  ],
  "scripts/deploy-indexer-rollback.sh": [
    'REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"',
    'cd "$REPO_ROOT"',
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    'pnpm deploy:indexer:promote "$REGISTERED" --yes',
    'echo "Dry run: nothing pushed."',
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    'git push --force-with-lease origin "$FULL_SHA:refs/heads/$DEPLOY_BRANCH"',
  ],
  "scripts/deploy-bridge.sh": [
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    'REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"',
    'cd "$REPO_ROOT"',
    'TAG="$(git rev-parse --short HEAD)"',
  ],
};

/**
 * Collect deploy wrappers under a repo-relative directory.
 *
 * The walk is recursive, so it covers both the flat `scripts/` layout in use
 * today and the `scripts/deploy/` directory that a later phase of the scripts
 * reorganization introduces. A directory that does not exist yet is skipped,
 * not fatal. Symlinks are never followed — `isDirectory()` is false for a
 * symlinked directory — so a link under `scripts/` cannot make this walk cycle.
 */
function collectDeployWrappers(relativeDir) {
  let entries;
  try {
    entries = readdirSync(resolve(ROOT, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const found = [];
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...collectDeployWrappers(relativePath));
    } else if (entry.name.startsWith("deploy-") && entry.name.endsWith(".sh")) {
      found.push(relativePath);
    }
  }
  return found;
}

const discovered = collectDeployWrappers("scripts")
  .filter((path) => path !== GUARD_PATH)
  .filter((path) =>
    readFileSync(resolve(ROOT, path), "utf8").includes("lib/deploy-guard.sh"),
  )
  .sort();

const scripts = discovered.map((path) => ({
  path,
  orderedAnchors: orderedAnchors[path],
}));

let failures = 0;

// Discovery used to be a flat readdir of `scripts/`. If the wrappers moved or
// were renamed, that readdir returned nothing, the loop below ran zero times,
// and the file exited 0 after printing "All 0 deploy scripts anchor repo
// commands after deploy-guard." The contract passed while checking nothing.
// The two assertions here close that: the subject list must be non-empty, and
// every path the map names must still be discovered and still source the guard.
if (discovered.length === 0) {
  console.error(
    "no deploy wrapper found under scripts/ — discovery matched nothing, so this file would otherwise assert nothing",
  );
  failures++;
}

const discoveredPaths = new Set(discovered);
const unmatchedAnchors = Object.keys(orderedAnchors).filter(
  (path) => !discoveredPaths.has(path),
);
if (unmatchedAnchors.length > 0) {
  console.error(
    `orderedAnchors names deploy wrappers discovery did not find: ${unmatchedAnchors.join(", ")}`,
  );
  console.error(
    "each must exist under scripts/ and still source lib/deploy-guard.sh; update the map when a wrapper moves, is renamed, or drops the guard",
  );
  failures++;
}

function assertOrdered(path, text, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle, cursor + 1);
    if (index === -1) {
      console.error(
        `${path}: missing ordered anchor ${JSON.stringify(needle)}`,
      );
      failures++;
      return;
    }
    cursor = index;
  }
}

for (const script of scripts) {
  const absolutePath = resolve(ROOT, script.path);
  const text = readFileSync(absolutePath, "utf8");
  const displayPath = relative(ROOT, absolutePath);

  if (!script.orderedAnchors) {
    console.error(`${displayPath}: missing orderedAnchors mapping`);
    failures++;
    continue;
  }

  assertOrdered(displayPath, text, script.orderedAnchors);
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `All ${scripts.length} deploy scripts anchor repo commands after deploy-guard.`,
  );
}
