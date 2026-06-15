#!/usr/bin/env node
/**
 * Static regression checks for deploy scripts that source deploy-guard.sh.
 *
 * The guard validates the repository that contains the guard file. These
 * scripts must then run git/build/deploy commands from that same repo root so
 * an absolute-path invocation from another checkout cannot deploy foreign CWD
 * artifacts after the monitoring-monorepo guard has passed.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const scripts = [
  {
    path: "scripts/deploy-indexer.sh",
    firstRepoCommand: "git ls-remote --heads origin",
  },
  {
    path: "scripts/deploy-bridge.sh",
    firstRepoCommand: 'TAG="$(git rev-parse --short HEAD)"',
  },
  {
    path: "scripts/deploy-gov-watchdog.sh",
    firstRepoCommand: "COMMIT_SHA=$(git rev-parse --short HEAD)",
  },
];

let failures = 0;

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

  assertOrdered(displayPath, text, [
    'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"',
    'REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"',
    'cd "$REPO_ROOT"',
    script.firstRepoCommand,
  ]);
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `All ${scripts.length} deploy scripts anchor repo commands after deploy-guard.`,
  );
}
