#!/usr/bin/env node
/**
 * Diff-aware ESLint baseline enforcement.
 *
 * Compares each current ESLint violation tuple to the per-package
 * `eslint-baseline.json` and exits non-zero on:
 *
 *   - any NEW tuple not absorbed by line-proximity matching against the
 *     baseline (additions blocked),
 *   - any STALE tuple (baseline says violation exists, current run says it
 *     doesn't, no nearby current entry absorbs it) in `check` mode —
 *     forces baseline pruning before merge.
 *
 * Modes:
 *   check  — fails on new tuples OR stale entries.
 *   update — writes a new baseline file, failing only if it would ADD
 *            tuples vs the existing baseline that aren't absorbed by
 *            line-proximity matching. Baseline growth beyond the
 *            proximity window requires deleting the file and re-running
 *            update (explicit reseed).
 *
 * Tuple identity is `(file, ruleId, message, line, linePreview)`. The
 * `growth()` function pairs add/remove entries within each stripped-key
 * `(file, ruleId, message)` bucket using line-distance matching:
 *
 *   - Exact-key match (same line + linePreview) → absorbed (no diff).
 *   - Same stripped key + line within `ABSORB_LINE_DISTANCE` → absorbed
 *     as a legitimate refactor (comment edit above the function,
 *     signature reformat, small insert).
 *   - Same stripped key + line beyond the proximity window → treated as
 *     a different violation and flagged.
 *   - No stripped-key match at all → flagged as a new violation.
 *
 * Why this design and not simpler alternatives:
 *
 *   - `--max-warnings <N>`: total-count budget; a PR could swap one
 *     violation for another and still pass.
 *   - ESLint 9.24+ bulk suppressions: count-per-(file, ruleId), so
 *     swap-in-same-file at finer granularity still passes.
 *   - Message-only keys: anonymous-function violations collide
 *     (e.g. two arrows with `Async arrow function has a complexity of 18`
 *     in the same file).
 *   - Strict line-only or strict content-fingerprint keys: harmless line
 *     shifts (a comment added above a baselined function) become
 *     forbidden additions and break the prune workflow.
 *
 * The line-proximity heuristic prefers refactor UX over catching a
 * narrow swap-in-place attack within the proximity window. The PR diff
 * makes the baseline rewrite visible to human reviewers, which is the
 * actual safety net for that residual attack surface.
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
        // `line` is part of the tuple key for strict identity. `linePreview`
        // is a content fingerprint also part of the key — together they
        // disambiguate two violations that happen to land on the same line
        // number in different revisions, and anonymous-function collisions
        // where many entries share the same `at`-line content.
        line: typeof m.line === "number" ? m.line : null,
        linePreview: linePreview(rel, m.line),
      });
    }
  }
  out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
      a.message.localeCompare(b.message) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.linePreview.localeCompare(b.linePreview),
  );
  return out;
}

function keyOf(v) {
  return `${v.file}\x00${v.ruleId ?? "<no-rule>"}\x00${v.message}\x00${v.line ?? "<no-line>"}\x00${v.linePreview ?? ""}`;
}

function strippedKeyOf(v) {
  return `${v.file}\x00${v.ruleId ?? "<no-rule>"}\x00${v.message}`;
}

function describe(v, delta) {
  const hint = v.linePreview ? `\n         > ${v.linePreview}` : "";
  const lineStr = v.line ? `:${v.line}` : "";
  return `  ${delta >= 0 ? "+" : ""}${delta}  ${v.file}${lineStr}\n         [${v.ruleId}] ${v.message}${hint}\n`;
}

// Detect baseline growth between two entry lists using LINE-PROXIMITY
// absorption. Adjacent edits (comment changes, signature reformatting,
// small inserts above a baselined function) shift the linePreview window
// AND/OR the reported line number by a small amount; we treat such
// shifts as legitimate refactors. Larger jumps — a different violation
// in the same file with the same rule message landing at an unrelated
// line — are flagged as growth.
//
// Codex round 3 wanted strict line-keyed identity so swap-in-place
// fails. Round 4/5 wanted shifts not to break update. Round 6 wanted
// same-message swaps to be caught, not absorbed by stripped-key
// matching. Line proximity threads the needle: same stripped key +
// nearby line = refactor (absorbed); same stripped key + distant line
// = different violation (flagged). The proximity threshold below is a
// pragmatic limit on "how far can a baselined violation move and still
// be called the same one"; tune as the baselines mature.
const ABSORB_LINE_DISTANCE = 10;

function growth(referenceEntries, currentEntries) {
  // Group entries by stripped key so we can pair add/remove within each
  // bucket using line-distance matching.
  function group(entries) {
    const g = new Map();
    for (const v of entries) {
      const sk = strippedKeyOf(v);
      const list = g.get(sk) ?? [];
      list.push(v);
      g.set(sk, list);
    }
    return g;
  }
  const refByStripped = group(referenceEntries);
  const curByStripped = group(currentEntries);

  const out = [];
  const allKeys = new Set([...refByStripped.keys(), ...curByStripped.keys()]);
  for (const sk of allKeys) {
    const refList = (refByStripped.get(sk) ?? []).slice();
    const curList = (curByStripped.get(sk) ?? []).slice();
    // Remove exact-key matches first (same line + linePreview).
    const exact = (a, b) => keyOf(a) === keyOf(b);
    for (let i = curList.length - 1; i >= 0; i--) {
      const j = refList.findIndex((r) => exact(curList[i], r));
      if (j >= 0) {
        refList.splice(j, 1);
        curList.splice(i, 1);
      }
    }
    // For remaining current entries, find a reference entry within the
    // proximity window. This absorbs line-shift refactors.
    for (let i = curList.length - 1; i >= 0; i--) {
      const cur = curList[i];
      const j = refList.findIndex(
        (r) =>
          typeof cur.line === "number" &&
          typeof r.line === "number" &&
          Math.abs(cur.line - r.line) <= ABSORB_LINE_DISTANCE,
      );
      if (j >= 0) {
        refList.splice(j, 1);
        curList.splice(i, 1);
      }
    }
    // Remaining current entries are genuine additions (no near-match
    // reference entry); remaining reference entries are stale (no
    // near-match current entry). Only additions count as growth here;
    // stale entries are handled by the stale-check branch in check mode.
    for (const v of curList) out.push({ entry: v });
  }
  return out;
}

const current = flatten(eslintOutput);
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;

if (mode === "update") {
  // Reject genuine baseline growth: an addition that has no nearby
  // reference entry on the same stripped key fails update. Line-shift
  // refactors (where a baselined violation's reported line moves within
  // ABSORB_LINE_DISTANCE) absorb cleanly. To grow a baseline deliberately
  // (e.g. seeding a new package, or after a large refactor that moves a
  // violation farther than the proximity window), delete
  // eslint-baseline.json first; an absent file is treated as initial seed.
  if (baseline !== null) {
    const additions = growth(baseline, current);
    if (additions.length > 0) {
      process.stderr.write(
        `✖ update would grow ${baselinePath} by ${additions.length} tuple(s) with no nearby reference entry:\n`,
      );
      for (const a of additions) process.stderr.write(describe(a.entry, +1));
      process.stderr.write(
        `\nThe baseline is prune-only. Fix the new violations rather than baselining\n` +
          `them. Line-shift refactors within ${ABSORB_LINE_DISTANCE} lines of an existing\n` +
          `baseline entry absorb automatically — larger jumps require an explicit reseed:\n` +
          `delete eslint-baseline.json and re-run \`lint:baseline:update\`.\n`,
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

// Strict identity here: ESLint reports an issue, baseline already has it,
// no problem. New issues that aren't in baseline (even by proximity) fail.
const newViolations = growth(baseline ?? [], current);
const staleEntries = growth(current, baseline ?? []);

let failed = false;

if (newViolations.length > 0) {
  process.stderr.write(
    `✖ ${newViolations.length} new ESLint violation(s) not in eslint-baseline.json:\n`,
  );
  for (const v of newViolations) process.stderr.write(describe(v.entry, +1));
  process.stderr.write(
    `\nFix these — the baseline is prune-only. (See scripts/eslint-baseline-diff.mjs.)\n`,
  );
  failed = true;
}

if (staleEntries.length > 0) {
  // Stale entries (baseline says violation exists, current run says it
  // doesn't, and no nearby current entry on the same stripped key
  // absorbed it) used to warn-and-exit-0. That let an unrelated PR that
  // happened to fix a violation leave the stale tuple in the baseline; a
  // future PR could then re-introduce the same violation in the same file
  // with the same message and the check would treat it as already
  // baselined. Fail instead and require the author to run
  // `lint:baseline:update` to prune.
  process.stderr.write(
    `✖ ${staleEntries.length} stale baseline entries (fixed but not pruned). ` +
      `run \`pnpm lint:baseline:update\` to clean before merge.\n`,
  );
  for (const v of staleEntries) process.stderr.write(describe(v.entry, -1));
  failed = true;
}

// Optional merge-base check: when `ESLINT_BASELINE_MAIN` env var points
// at a copy of main's `eslint-baseline.json`, also assert that HEAD's
// baseline doesn't grow tuples vs main beyond what line-proximity
// absorption allows. This catches PRs that edit the baseline file itself
// (manually or via reseed) to admit new violations alongside the code
// that introduces them — `update`'s prune-only guarantee only protects
// the path through `update`, not hand-edits. CI extracts main's baseline
// via `git show origin/main:<pkg>/eslint-baseline.json`.
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
    const mergeBaseGrowth = growth(mainBaseline, baseline ?? []);
    if (mergeBaseGrowth.length > 0) {
      process.stderr.write(
        `✖ ${mergeBaseGrowth.length} baseline tuple(s) added vs origin/main with no nearby reference entry:\n`,
      );
      for (const a of mergeBaseGrowth)
        process.stderr.write(describe(a.entry, +1));
      process.stderr.write(
        `\nBaseline can only shrink across PRs (line-shift refactors within ${ABSORB_LINE_DISTANCE} lines absorb;\n` +
          `larger jumps are treated as new violations). Fix these rather than baselining them.\n`,
      );
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
