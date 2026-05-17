#!/usr/bin/env node
/**
 * Diff-aware ESLint baseline enforcement.
 *
 * Compares each current ESLint violation tuple to the per-package
 * `eslint-baseline.json` and exits non-zero on:
 *
 *   - any NEW tuple not in the baseline (additions blocked),
 *   - any STALE tuple (baseline says violation exists, current run says it
 *     doesn't) in `check` mode — forces baseline pruning before merge.
 *
 * Modes:
 *   check  — fails on new tuples OR stale entries.
 *   update — fails if it would ADD tuples vs the existing baseline; only
 *            allows pruning. Baseline growth requires deleting the file
 *            and re-running update from a clean state (initial seed only).
 *
 * Why not `--max-warnings <N>` (count budget): a PR could swap one
 * violation for another and pass. Why not ESLint 9.24+ bulk suppressions:
 * count-per-(file, ruleId), so swap-in-same-file passes. This script
 * uses tuple identity `(file, ruleId, message)` plus `line` for
 * rules whose message doesn't already identify the violation location
 * (`LOCATION_KEYED_RULES` below). For rules like `complexity` that embed
 * function name + value in the message, the message itself is unique
 * enough; for rules like `max-depth` that emit a generic
 * "Blocks are nested too deeply (N)", we add line so two equally-deep
 * blocks in the same file are distinguishable.
 *
 * Usage:
 *   node ../scripts/eslint-baseline-diff.mjs check
 *   node ../scripts/eslint-baseline-diff.mjs update
 *
 * Run from each package's directory. Looks for `eslint-baseline.json` in cwd.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Rules whose message does NOT include enough context to distinguish two
// violations in the same file. For these we include the source line in the
// tuple key so swap-in-same-file is caught. A line shift from unrelated
// edits will surface as both a stale entry AND a new tuple — running
// `lint:baseline:update` then prunes the stale entry and the new tuple is
// rejected unless it's a net-zero replacement (same key minus line).
const LOCATION_KEYED_RULES = new Set([
  "max-depth",
  "sonarjs/no-collapsible-if",
  "sonarjs/no-small-switch",
  "sonarjs/no-redundant-jump",
  "sonarjs/no-nested-functions",
  "sonarjs/no-nested-conditional",
  "sonarjs/no-nested-template-literals",
]);

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
      const entry = { file: rel, ruleId: m.ruleId, message: m.message };
      if (LOCATION_KEYED_RULES.has(m.ruleId) && typeof m.line === "number") {
        entry.line = m.line;
      }
      out.push(entry);
    }
  }
  out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
      a.message.localeCompare(b.message) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  return out;
}

function keyOf(v) {
  const locSuffix = v.line != null ? `\x00${v.line}` : "";
  return `${v.file}\x00${v.ruleId ?? "<no-rule>"}\x00${v.message}${locSuffix}`;
}

function countMap(list) {
  const m = new Map();
  for (const v of list) {
    const key = keyOf(v);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function describe(key, delta) {
  const parts = key.split("\x00");
  const [file, ruleId, message, line] = parts;
  const loc = line ? `:${line}` : "";
  return `  ${delta >= 0 ? "+" : ""}${delta}  ${file}${loc}\n         [${ruleId}] ${message}\n`;
}

const current = flatten(eslintOutput);
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;

const currentCounts = countMap(current);
const baselineCounts = baseline ? countMap(baseline) : new Map();

if (mode === "update") {
  // Reject baseline growth: update mode prunes stale entries (and absorbs
  // line shifts when message identity is otherwise stable) but refuses to
  // ADD new tuples. New violations must be FIXED, not baselined. To grow
  // a baseline deliberately (e.g. seeding a new package), delete
  // eslint-baseline.json first; an absent file is treated as initial seed.
  if (baseline !== null) {
    const additions = [];
    for (const [key, count] of currentCounts) {
      const baselineCount = baselineCounts.get(key) ?? 0;
      if (count > baselineCount) {
        additions.push({ key, delta: count - baselineCount });
      }
    }
    if (additions.length > 0) {
      process.stderr.write(
        `✖ update would add ${additions.length} new tuple(s) to ${baselinePath}:\n`,
      );
      for (const v of additions) process.stderr.write(describe(v.key, v.delta));
      process.stderr.write(
        `\nThe baseline is prune-only. Fix the new violations rather than baselining\n` +
          `them. For a deliberate baseline reseed (e.g. accepting a new package), delete\n` +
          `eslint-baseline.json first and re-run \`lint:baseline:update\`.\n`,
      );
      process.exit(1);
    }
  }
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  process.stdout.write(`wrote ${current.length} entries to ${baselinePath}\n`);
  process.exit(0);
}

// check mode
if (baseline === null) {
  if (current.length === 0) {
    process.exit(0);
  }
  process.stderr.write(
    `no eslint-baseline.json found; ${current.length} errors present. ` +
      `run \`pnpm lint:baseline:update\` to seed.\n`,
  );
  process.exit(1);
}

const newViolations = [];
for (const [key, count] of currentCounts) {
  const baselineCount = baselineCounts.get(key) ?? 0;
  if (count > baselineCount) {
    newViolations.push({ key, delta: count - baselineCount });
  }
}

const staleEntries = [];
for (const [key, count] of baselineCounts) {
  const currentCount = currentCounts.get(key) ?? 0;
  if (currentCount < count) {
    staleEntries.push({ key, delta: currentCount - count });
  }
}

let failed = false;

if (newViolations.length > 0) {
  process.stderr.write(
    `✖ ${newViolations.length} new ESLint violation(s) not in eslint-baseline.json:\n`,
  );
  for (const v of newViolations) process.stderr.write(describe(v.key, v.delta));
  process.stderr.write(
    `\nFix these — the baseline is prune-only. (See scripts/eslint-baseline-diff.mjs.)\n`,
  );
  failed = true;
}

if (staleEntries.length > 0) {
  // Stale entries (baseline says violation exists, current run says it
  // doesn't) used to warn-and-exit-0. That let an unrelated PR that
  // happened to fix a violation leave the stale tuple in the baseline; a
  // future PR could then re-introduce the same violation in the same file
  // with the same message and the check would treat it as already
  // baselined. Fail instead and require the author to run
  // `lint:baseline:update` to prune.
  process.stderr.write(
    `✖ ${staleEntries.length} stale baseline entries (fixed but not pruned). ` +
      `run \`pnpm lint:baseline:update\` to clean before merge.\n`,
  );
  for (const v of staleEntries) process.stderr.write(describe(v.key, v.delta));
  failed = true;
}

process.exit(failed ? 1 : 0);
