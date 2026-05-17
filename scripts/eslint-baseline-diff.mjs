#!/usr/bin/env node
/**
 * Diff-aware ESLint baseline enforcement.
 *
 * Reads ESLint's `--format json` output from stdin, compares each violation
 * tuple `(file, ruleId, message)` to a per-package `eslint-baseline.json`,
 * and exits non-zero on any NEW tuple (or any duplicate count increase)
 * that isn't already in the baseline.
 *
 * Why not `--max-warnings <N>` (codex P2 #3253043406): total-count budgeting
 * lets a PR delete one violation and add a different one and still pass.
 *
 * Why not ESLint 9.24+ bulk suppressions (codex P2 #3254553397): those are
 * count-based per `(file, ruleId)`, so a PR can swap one function's
 * `complexity` violation for another function's in the same file and still
 * pass — same gap, finer granularity, but not location-stable.
 *
 * This script uses `(file, ruleId, message)` as the violation identity. The
 * message contains rule-specific identifiers (function name + value for
 * `complexity` / `max-lines-per-function` / `sonarjs/cognitive-complexity`;
 * count for `max-params`; etc.), so renaming a function or changing its
 * complexity surfaces as a NEW tuple and fails — even if the file's count
 * stays the same.
 *
 * Usage:
 *   pnpm exec eslint . --format json | node ../scripts/eslint-baseline-diff.mjs check
 *   pnpm exec eslint . --format json | node ../scripts/eslint-baseline-diff.mjs update
 *
 * Run from each package's directory. Looks for `eslint-baseline.json` in cwd.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "check";
const cwd = process.cwd();
const baselinePath = resolve(cwd, "eslint-baseline.json");

// Run eslint directly so we can distinguish "no violations" from
// "eslint crashed and produced no output." The diff-check is the gate;
// running eslint inside the script keeps the contract self-contained.
const eslintRun = spawnSync(
  "pnpm",
  ["exec", "eslint", ".", "--format", "json"],
  { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
if (eslintRun.error) {
  process.stderr.write(
    `eslint invocation failed: ${eslintRun.error.message}\n`,
  );
  process.exit(2);
}
if (!eslintRun.stdout || !eslintRun.stdout.trim().startsWith("[")) {
  process.stderr.write(
    `eslint produced no JSON output (exit ${eslintRun.status}):\n${eslintRun.stderr}\n`,
  );
  process.exit(2);
}
const eslintOutput = JSON.parse(eslintRun.stdout);

function flatten(output) {
  const out = [];
  for (const file of output) {
    const rel = file.filePath.replace(cwd + "/", "");
    for (const m of file.messages) {
      if (m.severity !== 2) continue;
      out.push({ file: rel, ruleId: m.ruleId, message: m.message });
    }
  }
  out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
      a.message.localeCompare(b.message),
  );
  return out;
}

const current = flatten(eslintOutput);

if (mode === "update") {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  process.stdout.write(`wrote ${current.length} entries to ${baselinePath}\n`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  if (current.length === 0) {
    process.exit(0);
  }
  process.stderr.write(
    `no eslint-baseline.json found; ${current.length} errors present. ` +
      `run \`pnpm lint:baseline:update\` to seed.\n`,
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function countMap(list) {
  const m = new Map();
  for (const v of list) {
    const key = `${v.file}\x00${v.ruleId}\x00${v.message}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

const baselineCounts = countMap(baseline);
const currentCounts = countMap(current);

const newViolations = [];
for (const [key, count] of currentCounts) {
  const baselineCount = baselineCounts.get(key) ?? 0;
  if (count > baselineCount) {
    newViolations.push({
      key,
      delta: count - baselineCount,
    });
  }
}

const staleEntries = [];
for (const [key, count] of baselineCounts) {
  const currentCount = currentCounts.get(key) ?? 0;
  if (currentCount < count) {
    staleEntries.push({ key, delta: count - currentCount });
  }
}

if (newViolations.length > 0) {
  process.stderr.write(
    `✖ ${newViolations.length} new ESLint violation(s) not in eslint-baseline.json:\n`,
  );
  for (const v of newViolations) {
    const [file, ruleId, message] = v.key.split("\x00");
    process.stderr.write(
      `  +${v.delta}  ${file}\n         [${ruleId}] ${message}\n`,
    );
  }
  process.stderr.write(
    `\nTo accept these as new baseline entries: pnpm lint:baseline:update\n`,
  );
  process.exit(1);
}

if (staleEntries.length > 0) {
  process.stdout.write(
    `⚠ ${staleEntries.length} stale baseline entries (fixed but not pruned). ` +
      `run pnpm lint:baseline:update to clean.\n`,
  );
  for (const v of staleEntries) {
    const [file, ruleId, message] = v.key.split("\x00");
    process.stdout.write(`  -${v.delta}  ${file} [${ruleId}] ${message}\n`);
  }
}

process.exit(0);
