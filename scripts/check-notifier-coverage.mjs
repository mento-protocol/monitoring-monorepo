#!/usr/bin/env node
/**
 * Structural assertion: every workflow that runs on push-to-main or on a
 * schedule must appear in the notify-slack-on-main-failure.yml workflow_run
 * list. A workflow that is missing means silent failures — the whole point of
 * that notifier is to page for any main-branch or scheduled gate failure.
 *
 * No external dependencies — reads files with pure Node.js.
 *
 * Run: `node scripts/check-notifier-coverage.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseName,
  hasPushMain,
  hasSchedule,
  parseNotifierList,
} from "./check-notifier-coverage-helpers.mjs";

const ROOT = process.cwd();
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const NOTIFIER_FILE = join(WORKFLOWS_DIR, "notify-slack-on-main-failure.yml");

// Workflows that are intentionally excluded from the notifier:
//   - The notifier itself (would cause an infinite loop).
//   - Mutation Testing: weekly, advisory, non-blocking — false-paging on
//     a flaky mutation run is worse than the missed signal.
const EXCLUDED_NAMES = new Set([
  "Notify Slack on main-branch workflow failure",
  "Mutation Testing",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

/** @param {string} msg */
function fail(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exitCode = 1;
}

/** @param {string} msg */
function ok(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const notifierText = readFileSync(NOTIFIER_FILE, "utf8");
const coveredNames = parseNotifierList(notifierText);

if (coveredNames.size === 0) {
  fail(
    "Could not parse workflow_run.workflows list from notify-slack-on-main-failure.yml — check the file structure.",
  );
  process.exit(1);
}

console.log(
  `Notifier covers ${coveredNames.size} workflow(s): ${[...coveredNames].join(", ")}\n`,
);

const files = readdirSync(WORKFLOWS_DIR).filter(
  (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
);

let checked = 0;
for (const file of files) {
  const filePath = join(WORKFLOWS_DIR, file);
  const text = readFileSync(filePath, "utf8");
  // Derive effective workflow name: explicit name: field, or the repo-relative
  // file path when omitted (GitHub's documented fallback display name).
  const explicitName = parseName(text);
  const name = explicitName ?? relative(ROOT, filePath);
  if (EXCLUDED_NAMES.has(name)) continue;

  const needsCoverage = hasPushMain(text) || hasSchedule(text);
  if (!needsCoverage) continue;

  checked++;
  if (coveredNames.has(name)) {
    ok(`${name}  (${file})`);
  } else {
    fail(
      `"${name}" (${file}) runs on push/schedule but is NOT listed in ` +
        `notify-slack-on-main-failure.yml workflow_run.workflows. ` +
        `Add it to close the silent-failure gap.`,
    );
  }
}

if (checked === 0) {
  fail("No push/schedule workflows found — check WORKFLOWS_DIR path.");
  process.exit(1);
}

if (process.exitCode !== 1) {
  console.log(`\nAll ${checked} push/schedule workflow(s) are covered.`);
}
