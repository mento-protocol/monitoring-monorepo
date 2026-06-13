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
import { join } from "node:path";

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

// ── parse helpers (regex-only, no new deps) ──────────────────────────────────

/**
 * Extract the `name:` field value from a workflow YAML text.
 * Returns null if not found.
 * @param {string} text
 * @returns {string|null}
 */
function parseName(text) {
  const m = text.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

/**
 * Returns true if the workflow has an `on.push` trigger targeting `main`.
 * Handles both inline `push: {branches: [main]}` and block-scalar forms.
 * @param {string} text
 */
function hasPushMain(text) {
  // Extract the `on:` block — everything until the next top-level key.
  const onMatch = text.match(/^on:\s*\n([\s\S]*?)(?=^\S)/m);
  if (!onMatch) return false;
  const onBlock = onMatch[1];

  // Look for a `push:` sub-key within the on: block, then capture everything
  // until the next same-level (2-space-indented) key OR end of the on: block.
  const pushMatch = onBlock.match(/^ {2}push:\s*\n([\s\S]*?)(?=^ {2}\S|$)/m);
  if (!pushMatch) return false;
  const pushBlock = pushMatch[1];

  // Check that `branches` contains `main`.
  return /branches:\s*\[?[^\]]*\bmain\b/.test(pushBlock);
}

/**
 * Returns true if the workflow has an `on.schedule` trigger.
 * @param {string} text
 */
function hasSchedule(text) {
  return /^ {2}schedule:\s*$/m.test(text);
}

/**
 * Extract the list of workflow names from the notifier's workflow_run.workflows
 * list. Returns a Set of strings.
 * @param {string} text
 */
function parseNotifierList(text) {
  // Find the `workflows:` key under `workflow_run:` and collect all `- Name` entries.
  const workflowRunMatch = text.match(
    /workflow_run:\s*\n\s+workflows:\s*\n([\s\S]*?)(?=\s+types:)/,
  );
  if (!workflowRunMatch) return new Set();

  const listBlock = workflowRunMatch[1];
  const names = new Set();
  for (const m of listBlock.matchAll(/^\s+-\s+(.+)$/gm)) {
    names.add(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return names;
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
  const name = parseName(text);

  if (!name) continue; // no name: field — skip (e.g. reusable workflow fragments)
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
