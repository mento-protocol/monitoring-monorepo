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
 * Tuple identity is `(file, ruleId, message, linePreview)`, where
 * `linePreview` is the trimmed source content (first 80 chars) at the
 * violation's reported line. Why content fingerprint instead of line
 * number or message alone:
 *
 *   - `--max-warnings <N>`: a PR could swap one violation for another and
 *     pass the count budget.
 *   - ESLint 9.24+ bulk suppressions are count-per-(file, ruleId), so
 *     swap-in-same-file at finer granularity still passes.
 *   - Message-only keys collide for anonymous functions: `complexity` and
 *     `sonarjs/cognitive-complexity` produce identical messages
 *     ("Async arrow function has a complexity of 18...") for distinct
 *     unnamed arrows in the same file. Swap-in-place would pass.
 *   - Line-only keys break on pure line shifts: an unrelated edit
 *     anywhere above a baselined function changes only the `line`,
 *     forcing reseeds for non-substantive changes.
 *
 * The content fingerprint is stable across pure line shifts (same source
 * line moves up or down, same content → same key) and discriminating
 * across swap-in-place (different source content → different key).
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

const sourceCache = new Map();
function getSourceLines(absPath) {
  if (sourceCache.has(absPath)) return sourceCache.get(absPath);
  let lines = [];
  try {
    lines = readFileSync(absPath, "utf8").split("\n");
  } catch {
    // empty array is fine; linePreview falls through to ""
  }
  sourceCache.set(absPath, lines);
  return lines;
}

// Three-line window joined with " | ". Single-line previews collide for
// duplicate function signatures (e.g. two anonymous arrows in the same
// file with `}): Promise<void> => {` at their reported `m.line`). The
// previous and next non-empty lines almost always include the unique
// const-assignment name or first body statement, which discriminates.
const LINE_PREVIEW_MAX = 200;
function linePreview(file, lineNo) {
  if (typeof lineNo !== "number" || lineNo < 1) return "";
  const lines = getSourceLines(resolve(cwd, file));
  const before = lines[lineNo - 2]?.trim() ?? "";
  const at = lines[lineNo - 1]?.trim() ?? "";
  const after = lines[lineNo]?.trim() ?? "";
  return `${before} | ${at} | ${after}`.slice(0, LINE_PREVIEW_MAX);
}

function flatten(output) {
  const out = [];
  for (const file of output) {
    const rel = file.filePath.replace(cwd + "/", "");
    for (const m of file.messages) {
      if (m.severity !== 2) continue;
      out.push({
        file: rel,
        ruleId: m.ruleId,
        message: m.message,
        linePreview: linePreview(rel, m.line),
      });
    }
  }
  out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
      a.message.localeCompare(b.message) ||
      a.linePreview.localeCompare(b.linePreview),
  );
  return out;
}

function keyOf(v) {
  return `${v.file}\x00${v.ruleId ?? "<no-rule>"}\x00${v.message}\x00${v.linePreview ?? ""}`;
}

// Stripped key = (file, ruleId, message), no linePreview. Used to absorb
// "harmless fingerprint shifts" — adjacent edits that change the source
// content around a baselined violation without changing the violation
// itself. A 1-for-1 add+remove on the same stripped key is treated as a
// refactor, not as growth.
function strippedKeyOf(key) {
  const parts = key.split("\x00");
  return parts.slice(0, 3).join("\x00");
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
  const [file, ruleId, message, preview] = key.split("\x00");
  const hint = preview ? `\n         > ${preview}` : "";
  return `  ${delta >= 0 ? "+" : ""}${delta}  ${file}\n         [${ruleId}] ${message}${hint}\n`;
}

// Detect baseline growth vs a reference counts map using stripped-key
// absorption. Same `(file, ruleId, message)` add+remove pairs cancel
// (legitimate refactor); only NET additions per stripped key count as
// growth. Returns an array of `{strippedKey, net}` entries, empty if no
// growth.
function strippedKeyGrowth(referenceCounts, currentCounts) {
  const additionsByStripped = new Map();
  const removalsByStripped = new Map();
  for (const [key, count] of currentCounts) {
    const referenceCount = referenceCounts.get(key) ?? 0;
    if (count > referenceCount) {
      const s = strippedKeyOf(key);
      additionsByStripped.set(
        s,
        (additionsByStripped.get(s) ?? 0) + (count - referenceCount),
      );
    }
  }
  for (const [key, count] of referenceCounts) {
    const currentCount = currentCounts.get(key) ?? 0;
    if (count > currentCount) {
      const s = strippedKeyOf(key);
      removalsByStripped.set(
        s,
        (removalsByStripped.get(s) ?? 0) + (count - currentCount),
      );
    }
  }
  const growth = [];
  for (const [s, addCount] of additionsByStripped) {
    const removeCount = removalsByStripped.get(s) ?? 0;
    const net = addCount - removeCount;
    if (net > 0) growth.push({ strippedKey: s, net });
  }
  return growth;
}

const current = flatten(eslintOutput);
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;

const currentCounts = countMap(current);
const baselineCounts = baseline ? countMap(baseline) : new Map();

if (mode === "update") {
  // Update mode rejects NET baseline growth per stripped key. A 1-for-1
  // add+remove on the same `(file, ruleId, message)` is treated as a
  // legitimate refactor (function renamed, signature reformatted,
  // adjacent edit shifted the linePreview window). A genuine new
  // violation — a new stripped key, or extra count on an existing one —
  // is rejected; the author must fix the violation. To grow a baseline
  // deliberately (e.g. seeding a new package), delete eslint-baseline.json
  // first; an absent file is treated as initial seed.
  if (baseline !== null) {
    const growth = strippedKeyGrowth(baselineCounts, currentCounts);
    if (growth.length > 0) {
      process.stderr.write(
        `✖ update would grow ${baselinePath} by ${growth.length} net tuple(s):\n`,
      );
      for (const v of growth) {
        const [file, ruleId, message] = v.strippedKey.split("\x00");
        process.stderr.write(
          `  +${v.net}  ${file}\n         [${ruleId}] ${message}\n`,
        );
      }
      process.stderr.write(
        `\nThe baseline is prune-only. Fix the new violations rather than baselining\n` +
          `them. (Same-(file,ruleId,message) refactors absorb as 1-for-1 swaps.)\n` +
          `For a deliberate reseed (e.g. accepting a new package), delete\n` +
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

// Optional merge-base check: when `ESLINT_BASELINE_MAIN` env var points
// at a copy of main's `eslint-baseline.json`, also assert that HEAD's
// baseline doesn't grow net tuples vs main. This catches PRs that edit
// the baseline file itself (manually or via reseed) to admit new
// violations alongside the code that introduces them — `update` mode's
// prune-only guarantee only protects the path through `update`, not
// hand-edits. Stripped-key absorption matches the update-mode policy:
// legitimate refactors that move a violation within the same
// `(file, ruleId, message)` bucket pass; net growth fails. CI extracts
// main's baseline via `git show origin/main:<pkg>/eslint-baseline.json`
// and passes the path via this env var.
const mainBaselinePath = process.env.ESLINT_BASELINE_MAIN;
if (mainBaselinePath) {
  let mainBaseline = null;
  try {
    const txt = readFileSync(mainBaselinePath, "utf8").trim();
    if (txt.length > 0) mainBaseline = JSON.parse(txt);
  } catch {
    // File missing or unreadable — skip the check rather than failing.
    // Most commonly: package didn't exist on main yet.
  }
  if (Array.isArray(mainBaseline)) {
    const mainCounts = countMap(mainBaseline);
    const headCounts = baselineCounts;
    const growth = strippedKeyGrowth(mainCounts, headCounts);
    if (growth.length > 0) {
      process.stderr.write(
        `✖ ${growth.length} baseline tuple(s) added vs origin/main (per stripped key):\n`,
      );
      for (const v of growth) {
        const [file, ruleId, message] = v.strippedKey.split("\x00");
        process.stderr.write(
          `  +${v.net}  ${file}\n         [${ruleId}] ${message}\n`,
        );
      }
      process.stderr.write(
        `\nBaseline can only shrink across PRs. Fix the new violations rather than\n` +
          `baselining them. (Same-(file,ruleId,message) refactors absorb as 1-for-1.)\n`,
      );
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
