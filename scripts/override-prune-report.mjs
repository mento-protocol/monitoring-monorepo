#!/usr/bin/env node
/**
 * Pruning report for `pnpm.overrides` (CVE-floor pins) and
 * `minimumReleaseAgeExclude` (release-age gate bypasses).
 *
 * Both lists are meant to be temporary — pins tied to a specific advisory
 * batch — but nothing today flags an entry once its reason has naturally
 * resolved, so they only ever grow. This script is REPORT ONLY: it never
 * edits package.json / pnpm-workspace.yaml and it never fails CI (always
 * exits 0). Pruning an entry is always a follow-up, human-reviewed PR — see
 * #881/#868/#837 for why blind override removal has broken prod delivery
 * paths before (the undici 6->8 forward-resolution incident).
 *
 * ── Overrides heuristic ──────────────────────────────────────────────────
 * pnpm-lock.yaml mirrors the *effective* `overrides:` map at the top of the
 * file (already resolved from whichever of package.json / pnpm-workspace.yaml
 * pnpm actually reads for that root) — that's the canonical, normalized
 * source this script reads, rather than re-parsing package.json /
 * pnpm-workspace.yaml by hand.
 *
 * The lockfile only records the POST-override resolution, so this script
 * can't directly ask "what would this resolve to without the override".
 * Instead, per override entry:
 *   1. Extract the override's "floor" version from its replacement value.
 *   2. Collect every distinct version of that package recorded anywhere in
 *      the lockfile's `packages:` section, filtered to the same major
 *      version line as the floor — so an unrelated major-version consumer
 *      of the same package name doesn't contaminate the read.
 *   3. If any same-major instance sits EXACTLY at the floor, the override
 *      is still doing active work (verdict: keep).
 *   4. If every same-major instance resolves ABOVE the floor with none
 *      pinned exactly to it, and the replacement is an EXACT pin (no `^`/
 *      `~`/`>=` prefix), natural resolution may already clear the floor
 *      without the override's help (verdict: possible-prune). A RANGE
 *      replacement resolving above its own floor is the expected, healthy
 *      state for an override still doing active work — a range only forces
 *      membership in it, not the exact minimum — so that case is `keep`,
 *      not a prune signal.
 *   5. If no same-major instance exists (or the package is absent entirely),
 *      nothing in the current graph exercises the override (verdict:
 *      possible-prune).
 *   6. Anything else (an instance below the floor) is an anomaly worth a
 *      human look before touching the override (verdict: needs-review).
 * This is a heuristic, not proof — it never recommends widening a bounded
 * range to an unbounded one, and every verdict still needs human
 * confirmation (e.g. removing the override and re-running `pnpm install` to
 * diff the resolved graph) before an override is actually deleted.
 *
 * ── minimumReleaseAgeExclude heuristic ───────────────────────────────────
 * These entries have no lockfile mirror (they're an install-time gate
 * setting, not a resolution artifact), so this script reads each
 * pnpm-workspace.yaml directly and uses `git blame` on the exact list-item
 * line to find how long it has gone unchanged. Entries older than
 * `--max-age-days` (default 90) are flagged stale for review. Fully local —
 * no registry calls, no network. This needs full git history: a shallow
 * clone (e.g. actions/checkout's default fetch-depth: 1) attributes every
 * line to the boundary commit, which would silently read as "just
 * changed" — the CI job checks out with `fetch-depth: 0`, and this script
 * detects a shallow repo and reports "unknown" instead of a false "recent"
 * as defense in depth.
 *
 * Covers the same 4 lockfile roots the weekly supply-chain advisory job
 * already audits (root workspace + the 3 standalone Cloud Build deploy
 * roots: alerts/infra/onchain-event-handler, alerts/infra/oncall-announcer,
 * governance-watchdog) — see .github/workflows/supply-chain.yml.
 *
 * Run:
 *   node scripts/override-prune-report.mjs
 *   node scripts/override-prune-report.mjs --max-age-days 60
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.env["OVERRIDE_PRUNE_REPORT_ROOT"] ?? process.cwd();
const DEFAULT_MAX_AGE_DAYS = 90;

// The 4 lockfile roots the weekly supply-chain advisory job already audits
// (see the `audit` job in .github/workflows/supply-chain.yml): the root
// workspace plus the 3 standalone Cloud Build deploy roots, each with its
// own pnpm-lock.yaml + pnpm-workspace.yaml outside the pnpm workspace.
export const LOCKFILE_ROOTS = [
  { label: "root", dir: "." },
  {
    label: "alerts/infra/onchain-event-handler",
    dir: "alerts/infra/onchain-event-handler",
  },
  {
    label: "alerts/infra/oncall-announcer",
    dir: "alerts/infra/oncall-announcer",
  },
  { label: "governance-watchdog", dir: "governance-watchdog" },
];

// ── minimal YAML-ish parsing ─────────────────────────────────────────────
//
// The two sections this script reads (pnpm-lock.yaml's `overrides:` mirror
// and pnpm-workspace.yaml's `minimumReleaseAgeExclude:` list) are both flat,
// single-level YAML in every root of this repo — no nested objects, anchors,
// or multi-line scalars. A small hand-rolled scanner is enough and avoids
// adding a YAML parser dependency (and the `pnpm install` it would require
// in CI) just for a report script.

/** @param {string} value */
function unquote(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

/** @param {string} value */
function stripYamlInlineComment(value) {
  const hashIndex = value.indexOf(" #");
  return (hashIndex === -1 ? value : value.slice(0, hashIndex)).trim();
}

/**
 * Slice the text between a top-level `header:` key and the next top-level
 * key (or EOF).
 * @param {string} text
 * @param {string} header
 * @returns {string | null}
 */
function extractTopLevelSection(text, header) {
  const match = new RegExp(`^${header}:\\s*$`, "m").exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const nextTopLevel = /^\S/m.exec(rest);
  return nextTopLevel ? rest.slice(0, nextTopLevel.index) : rest;
}

/**
 * Parse a flat `key: value` YAML mapping section (one entry per line).
 * @param {string} section
 * @returns {Map<string, string>}
 */
function parseFlatMap(section) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const rawLine of section.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(": ");
    if (colonIndex === -1) continue;
    const key = unquote(trimmed.slice(0, colonIndex).trim());
    const value = unquote(
      stripYamlInlineComment(trimmed.slice(colonIndex + 2)),
    );
    if (key) map.set(key, value);
  }
  return map;
}

/**
 * Extract a top-level YAML list (`key:\n  - item`) with 1-based line
 * numbers, so callers can `git blame` the exact line an entry lives on.
 * @param {string} text
 * @param {string} key
 * @returns {Array<{ value: string; line: number }>}
 */
function extractYamlListWithLines(text, key) {
  const lines = text.split("\n");
  const headerRe = new RegExp(`^${key}:\\s*$`);
  let inList = false;
  /** @type {Array<{ value: string; line: number }>} */
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inList) {
      if (headerRe.test(line)) inList = true;
      continue;
    }
    if (/^\S/.test(line)) break; // dedent -> list ended
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^-\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    items.push({
      value: unquote(stripYamlInlineComment(match[1])),
      line: i + 1,
    });
  }
  return items;
}

// ── lockfile parsing ──────────────────────────────────────────────────────

/**
 * @param {string} lockfileText
 * @returns {Map<string, string>}
 */
export function extractOverridesMap(lockfileText) {
  const section = extractTopLevelSection(lockfileText, "overrides");
  return section ? parseFlatMap(section) : new Map();
}

// Same key-matching approach as scripts/lockfile-lint.mjs's `totalEntries`
// regex: a top-level (2-space indent) YAML key ending in `:` at end-of-line,
// quoted or bare.
const PACKAGE_KEY_RE =
  /^ {2}('[^':\n]+@[^\n']+'|[^':\n ][^:\n]*@[^\n]+?):\s*$/gm;

/**
 * @param {string} rawKey
 * @returns {{ name: string; version: string } | null}
 */
function splitPackageKey(rawKey) {
  const key = unquote(rawKey);
  const searchFrom = key.startsWith("@") ? 1 : 0;
  const at = key.indexOf("@", searchFrom);
  if (at === -1) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * Every distinct version of every package instance recorded in the
 * lockfile's `packages:` section (bounded until `snapshots:`), keyed by bare
 * package name.
 * @param {string} lockfileText
 * @returns {Map<string, string[]>}
 */
export function extractPackageInstances(lockfileText) {
  const section = extractTopLevelSection(lockfileText, "packages");
  /** @type {Map<string, string[]>} */
  const instancesByName = new Map();
  if (!section) return instancesByName;

  PACKAGE_KEY_RE.lastIndex = 0;
  let match;
  while ((match = PACKAGE_KEY_RE.exec(section)) !== null) {
    const split = splitPackageKey(match[1]);
    // Local file:/link:/git+ sources don't carry a semver version — skip them.
    if (!split || !/^\d/.test(split.version)) continue;
    const existing = instancesByName.get(split.name);
    if (existing) existing.push(split.version);
    else instancesByName.set(split.name, [split.version]);
  }
  return instancesByName;
}

// ── override selector / version helpers ──────────────────────────────────

/**
 * @param {string} selector
 * @param {number} index
 */
function isPeerSelectorSeparator(selector, index) {
  const previous = selector[index - 1] ?? "";
  const next = selector[index + 1] ?? "";
  return (
    next !== "" &&
    next !== "=" &&
    previous !== "@" &&
    previous !== "<" &&
    previous !== ">" &&
    previous !== "=" &&
    !/\s|\|/.test(previous)
  );
}

/**
 * Splits a pnpm override selector on bare `>` path separators (e.g.
 * `parent>child`), distinct from `>`/`>=` used inside a version range.
 * Mirrors scripts/lockfile-lint.mjs's `peerQualifiedSelectorParts`.
 * @param {string} selector
 * @returns {string[]}
 */
function peerQualifiedSelectorParts(selector) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] === ">" && isPeerSelectorSeparator(selector, index)) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

/**
 * Strips any path qualifiers (`parent>child`) and version-range suffix from
 * a pnpm override selector, leaving the bare package name. Mirrors
 * scripts/lockfile-lint.mjs's `packageNameFromOverrideSelector`.
 * @param {string} selector
 * @returns {string}
 */
export function packageNameFromOverrideSelector(selector) {
  const parts = peerQualifiedSelectorParts(selector);
  const packageSelector = parts[parts.length - 1] ?? selector;
  const rangeSeparator = packageSelector.indexOf("@", 1);
  return rangeSeparator === -1
    ? packageSelector
    : packageSelector.slice(0, rangeSeparator);
}

/**
 * Extracts the "floor" version from an override replacement value — the
 * first semver-shaped token, stripping any range operator prefix (`^`, `~`,
 * `>=`, ...).
 * @param {string} replacement
 * @returns {string | null}
 */
export function floorFromReplacement(replacement) {
  const match = /\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.]+)?/.exec(replacement);
  return match ? match[0] : null;
}

/**
 * Whether a replacement is an exact pin (no leading range operator) rather
 * than a range like `^2.0.3` / `~2.0.3` / `>=2.0.3`. This matters for the
 * "above floor" verdict: an exact-pin override forces its target instances
 * to precisely the floor, so an instance resolving ABOVE it is a real signal
 * the override isn't the one holding that instance there. A range
 * replacement only forces membership in the range — resolving above its
 * minimum is the expected, healthy steady state for an override that's
 * still doing active work, not evidence it's dead.
 * @param {string} replacement
 * @returns {boolean}
 */
function isExactVersionReplacement(replacement) {
  return /^\d/.test(replacement.trim());
}

/** @param {string} version */
function majorOf(version) {
  return version.split(".")[0];
}

/**
 * Loose numeric-aware version comparator (no prerelease-precedence rules —
 * none of this repo's override floors carry prerelease tags today).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const partsA = a.split(/[.-]/);
  const partsB = b.split(/[.-]/);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numX = Number(x);
    const numY = Number(y);
    if (Number.isFinite(numX) && Number.isFinite(numY) && numX !== numY) {
      return numX - numY;
    }
    if (numX !== numY) return x.localeCompare(y);
  }
  return 0;
}

/**
 * @param {string[]} versions
 * @returns {string[]}
 */
function uniqueSorted(versions) {
  return Array.from(new Set(versions)).sort(compareVersions);
}

// ── verdicts ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ selector: string; replacement: string; verdict: string; evidence: string }} OverrideRow
 */

/**
 * @param {string} selector
 * @param {string} replacement
 * @param {Map<string, string[]>} instancesByName
 * @returns {OverrideRow}
 */
export function evaluateOverride(selector, replacement, instancesByName) {
  const name = packageNameFromOverrideSelector(selector);
  const allInstances = instancesByName.get(name) ?? [];

  if (allInstances.length === 0) {
    return {
      selector,
      replacement,
      verdict: "possible-prune",
      evidence: `no lockfile instance of "${name}" found — override may no longer be exercised`,
    };
  }

  const floor = floorFromReplacement(replacement);
  if (!floor) {
    return {
      selector,
      replacement,
      verdict: "manual-review",
      evidence: `could not parse a floor version from replacement "${replacement}"`,
    };
  }

  const bucket = allInstances.filter((v) => majorOf(v) === majorOf(floor));
  if (bucket.length === 0) {
    return {
      selector,
      replacement,
      verdict: "possible-prune",
      evidence: `no same-major "${name}" instance found (present: ${uniqueSorted(allInstances).join(", ")}) — the floor's major line may no longer be in use`,
    };
  }
  if (bucket.includes(floor)) {
    return {
      selector,
      replacement,
      verdict: "keep",
      evidence: `"${name}@${floor}" is present — override still appears to be enforcing the floor`,
    };
  }
  if (bucket.every((v) => compareVersions(v, floor) > 0)) {
    if (!isExactVersionReplacement(replacement)) {
      // A range replacement (e.g. `^2.0.3`) only forces membership in the
      // range — resolving above its floor is the expected, healthy state
      // for an override still doing active work, not a prune signal.
      return {
        selector,
        replacement,
        verdict: "keep",
        evidence: `"${replacement}" is a range floor; same-major "${name}" instance(s) (${uniqueSorted(bucket).join(", ")}) satisfy it above the minimum "${floor}" — expected for a range replacement, not evidence the override is unneeded`,
      };
    }
    return {
      selector,
      replacement,
      verdict: "possible-prune",
      evidence: `same-major "${name}" instance(s) (${uniqueSorted(bucket).join(", ")}) all resolve above the exact-pin floor "${floor}" with none pinned exactly to it — natural resolution may already clear it`,
    };
  }
  return {
    selector,
    replacement,
    verdict: "needs-review",
    evidence: `same-major "${name}" instance(s) below the floor (${uniqueSorted(bucket).join(", ")} vs floor "${floor}") — override may not be applying; investigate before pruning`,
  };
}

// ── minimumReleaseAgeExclude age check ────────────────────────────────────

/**
 * A shallow clone (e.g. actions/checkout's default fetch-depth: 1) attributes
 * every line to the boundary commit, so `git blame` would silently report
 * every entry as "just changed" instead of its true age. Detect that case so
 * callers can degrade to "unknown" rather than a false "recent".
 * @param {string} root
 * @returns {boolean}
 */
export function isShallowRepository(root) {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * @param {string} root
 * @param {string} relPath
 * @param {number} lineNumber
 * @returns {number | null} age in days, or null if undeterminable
 */
export function lineAgeDays(root, relPath, lineNumber) {
  if (isShallowRepository(root)) return null;
  const result = spawnSync(
    "git",
    [
      "blame",
      "-L",
      `${lineNumber},${lineNumber}`,
      "--porcelain",
      "--",
      relPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const match = /^author-time (\d+)/m.exec(result.stdout ?? "");
  if (!match) return null;
  const authorTimeMs = Number(match[1]) * 1000;
  return (Date.now() - authorTimeMs) / (1000 * 60 * 60 * 24);
}

/**
 * @typedef {{ value: string; verdict: string; evidence: string }} ExcludeRow
 */

/**
 * @param {string} root
 * @param {string} relPath
 * @param {{ value: string; line: number }} item
 * @param {number} maxAgeDays
 * @returns {ExcludeRow}
 */
export function evaluateExcludeEntry(root, relPath, item, maxAgeDays) {
  const ageDays = lineAgeDays(root, relPath, item.line);
  if (ageDays === null) {
    return {
      value: item.value,
      verdict: "unknown",
      evidence: "age undetermined (not tracked by git, or blame failed)",
    };
  }
  const rounded = Math.round(ageDays);
  if (ageDays > maxAgeDays) {
    return {
      value: item.value,
      verdict: "stale",
      evidence: `${rounded}d old (> ${maxAgeDays}d) — review whether the release-age bypass is still needed`,
    };
  }
  return {
    value: item.value,
    verdict: "recent",
    evidence: `${rounded}d old (<= ${maxAgeDays}d)`,
  };
}

// ── report formatting ─────────────────────────────────────────────────────

/**
 * @param {string} rootLabel
 * @param {OverrideRow[]} rows
 * @returns {string}
 */
export function formatOverridesTable(rootLabel, rows) {
  if (rows.length === 0) {
    return `### ${rootLabel} — pnpm.overrides\n\n_No override entries found._\n`;
  }
  const header =
    "| Override | Replacement | Verdict | Evidence |\n| --- | --- | --- | --- |\n";
  const body = rows
    .map(
      (r) =>
        `| \`${r.selector}\` | \`${r.replacement}\` | ${r.verdict} | ${r.evidence} |`,
    )
    .join("\n");
  return `### ${rootLabel} — pnpm.overrides\n\n${header}${body}\n`;
}

/**
 * @param {string} rootLabel
 * @param {ExcludeRow[]} rows
 * @returns {string}
 */
export function formatExcludeTable(rootLabel, rows) {
  if (rows.length === 0) {
    return `### ${rootLabel} — minimumReleaseAgeExclude\n\n_No entries found._\n`;
  }
  const header = "| Entry | Verdict | Evidence |\n| --- | --- | --- |\n";
  const body = rows
    .map((r) => `| \`${r.value}\` | ${r.verdict} | ${r.evidence} |`)
    .join("\n");
  return `### ${rootLabel} — minimumReleaseAgeExclude\n\n${header}${body}\n`;
}

/**
 * @param {string} root absolute path
 * @param {string} label
 * @param {number} maxAgeDays
 * @returns {string}
 */
export function reportForRoot(root, label, maxAgeDays) {
  const sections = [];

  const lockfilePath = resolve(root, "pnpm-lock.yaml");
  if (existsSync(lockfilePath)) {
    const lockfileText = readFileSync(lockfilePath, "utf8");
    const overrides = extractOverridesMap(lockfileText);
    const instancesByName = extractPackageInstances(lockfileText);
    const rows = Array.from(overrides, ([selector, replacement]) =>
      evaluateOverride(selector, replacement, instancesByName),
    );
    sections.push(formatOverridesTable(label, rows));
  } else {
    sections.push(
      `### ${label} — pnpm.overrides\n\n_Skipped: pnpm-lock.yaml not found._\n`,
    );
  }

  const workspacePath = resolve(root, "pnpm-workspace.yaml");
  if (existsSync(workspacePath)) {
    const workspaceText = readFileSync(workspacePath, "utf8");
    const items = extractYamlListWithLines(
      workspaceText,
      "minimumReleaseAgeExclude",
    );
    const rows = items.map((item) =>
      evaluateExcludeEntry(root, "pnpm-workspace.yaml", item, maxAgeDays),
    );
    sections.push(formatExcludeTable(label, rows));
  } else {
    sections.push(
      `### ${label} — minimumReleaseAgeExclude\n\n_Skipped: pnpm-workspace.yaml not found._\n`,
    );
  }

  return sections.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ maxAgeDays: number }}
 */
export function parseArgs(argv) {
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-age-days") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--max-age-days requires a positive number");
      }
      maxAgeDays = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { maxAgeDays };
}

function main() {
  const { maxAgeDays } = parseArgs(process.argv.slice(2));
  const sections = LOCKFILE_ROOTS.map(({ label, dir }) =>
    reportForRoot(resolve(REPO_ROOT, dir), label, maxAgeDays),
  );

  console.log("# Override + release-age-exclude prune report\n");
  console.log(
    "Report-only — never edits package.json/pnpm-workspace.yaml. Verdicts " +
      "are heuristic; every prune must be a human-reviewed follow-up PR.\n",
  );
  console.log(sections.join("\n"));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
