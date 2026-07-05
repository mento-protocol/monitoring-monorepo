#!/usr/bin/env node
/**
 * Unit tests for scripts/check-agent-context.mjs.
 *
 * The script itself scans live repo state (git ls-files, real settings/hook
 * files) and exits the process on failure, so it isn't a good target for a
 * synthetic-fixture end-to-end harness. Instead this tests the pure parsing,
 * staleness, and canonical-discovery helpers from
 * check-agent-context-helpers.mjs directly.
 *
 * Run: node scripts/check-agent-context.test.mjs
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import {
  assessStaleness,
  daysSince,
  discoverCanonicalFiles,
  FUTURE_SKEW_TOLERANCE_DAYS,
  missingCoreContextFiles,
  parseFrontmatter,
  STALE_AFTER_DAYS,
} from "./check-agent-context-helpers.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ── parseFrontmatter tests ────────────────────────────────────────────────────

console.log("\nparseFrontmatter");

test("parses a valid frontmatter block", () => {
  const data = parseFrontmatter(
    "---\ntitle: Spec\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-03\n---\n\n# Spec\n",
  );
  assert(data !== null, "expected frontmatter to parse");
  assert(data.title === "Spec", `expected title 'Spec', got ${data.title}`);
  assert(
    data.last_verified === "2026-07-03",
    `expected last_verified '2026-07-03', got ${data.last_verified}`,
  );
});

test("returns null when content has no frontmatter", () => {
  const data = parseFrontmatter("# Spec\n\nNo frontmatter here.\n");
  assert(data === null, "expected null for content without frontmatter");
});

test("returns null when the closing delimiter is missing", () => {
  const data = parseFrontmatter("---\ntitle: Spec\n\n# Spec\n");
  assert(data === null, "expected null for unterminated frontmatter block");
});

test("strips surrounding quotes from values", () => {
  const data = parseFrontmatter(
    "---\ntitle: \"Quoted Title\"\nowner: 'eng'\n---\n",
  );
  assert(
    data.title === "Quoted Title",
    `expected unquoted title, got ${JSON.stringify(data.title)}`,
  );
  assert(
    data.owner === "eng",
    `expected unquoted owner, got ${JSON.stringify(data.owner)}`,
  );
});

// ── daysSince tests ───────────────────────────────────────────────────────────

console.log("\ndaysSince");

test("returns 0 for today's date", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  const age = daysSince("2026-07-05", now);
  assert(age === 0, `expected 0, got ${age}`);
});

test("returns the correct day count for a past date", () => {
  const now = new Date("2026-07-05T00:00:00Z");
  const age = daysSince("2026-04-01", now);
  assert(age === 95, `expected 95, got ${age}`);
});

test("returns a negative number for a future date", () => {
  // check-agent-context.mjs's requireMetadata rejects last_verified more
  // than FUTURE_SKEW_TOLERANCE_DAYS in the future (verification can't
  // happen in the future) — daysSince itself just reports the (possibly
  // negative) elapsed days.
  const now = new Date("2026-07-05T00:00:00Z");
  const age = daysSince("2099-01-01", now);
  assert(age < 0, `expected a negative age, got ${age}`);
});

test("a same-local-day last_verified stays within the future-skew tolerance", () => {
  // A contributor east of UTC (up to UTC+14) can stamp their own local
  // "today" and have it land on UTC "tomorrow" until UTC midnight — e.g.
  // 2026-07-05 00:30 in Europe/Berlin (UTC+2) is 2026-07-04T22:30:00Z.
  // requireMetadata must not reject that as "in the future".
  const now = new Date("2026-07-04T22:30:00Z");
  const age = daysSince("2026-07-05", now);
  assert(
    age >= -FUTURE_SKEW_TOLERANCE_DAYS,
    `expected age within the future-skew tolerance, got ${age}`,
  );
});

test("a multi-day-future last_verified exceeds the tolerance", () => {
  const now = new Date("2026-07-05T00:00:00Z");
  const age = daysSince("2026-07-08", now);
  assert(
    age < -FUTURE_SKEW_TOLERANCE_DAYS,
    `expected age to exceed the future-skew tolerance, got ${age}`,
  );
});

test("returns null for an unparsable date", () => {
  const age = daysSince("not-a-date", new Date("2026-07-05T00:00:00Z"));
  assert(age === null, `expected null, got ${age}`);
});

test("returns null for a calendar date that doesn't exist", () => {
  // Date.UTC silently normalizes 2026-02-31 into 2026-03-03; daysSince must
  // reject it instead of treating the typo as a valid date.
  const age = daysSince("2026-02-31", new Date("2026-07-05T00:00:00Z"));
  assert(age === null, `expected null, got ${age}`);
});

// ── staleness policy window ───────────────────────────────────────────────────

console.log("\nstaleness policy window");

test("STALE_AFTER_DAYS is a positive number of days", () => {
  assert(
    Number.isInteger(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0,
    `expected a positive integer, got ${STALE_AFTER_DAYS}`,
  );
});

test("a last_verified within the window is not stale", () => {
  const now = new Date("2026-07-05T00:00:00Z");
  const age = daysSince("2026-07-03", now);
  assert(
    age <= STALE_AFTER_DAYS,
    `expected a fresh last_verified to stay within the window, got age ${age}`,
  );
});

test("a last_verified past the window is flagged stale", () => {
  const now = new Date("2026-07-05T00:00:00Z");
  const staleDate = new Date(now);
  staleDate.setUTCDate(staleDate.getUTCDate() - (STALE_AFTER_DAYS + 1));
  const isoDate = staleDate.toISOString().slice(0, 10);
  const age = daysSince(isoDate, now);
  assert(
    age > STALE_AFTER_DAYS,
    `expected last_verified ${isoDate} to exceed the ${STALE_AFTER_DAYS}-day window, got age ${age}`,
  );
});

// ── assessStaleness (requireMetadata's enforcement branch) ────────────────────
//
// check-agent-context.mjs's requireMetadata calls assessStaleness(age) with
// no options, so it always enforces the real STALE_AFTER_DAYS /
// FUTURE_SKEW_TOLERANCE_DAYS window. These tests exercise assessStaleness at
// exactly the same boundaries requireMetadata does, so a `<` → `<=` flip (or
// a dropped negation) on either comparison fails a test here.

console.log("\nassessStaleness");

test("a last_verified within the stale window passes (age === STALE_AFTER_DAYS)", () => {
  const status = assessStaleness(STALE_AFTER_DAYS);
  assert(status === "ok", `expected 'ok' at the boundary, got ${status}`);
});

test("a last_verified beyond the stale window fails (age === STALE_AFTER_DAYS + 1)", () => {
  const status = assessStaleness(STALE_AFTER_DAYS + 1);
  assert(
    status === "stale",
    `expected 'stale' one day past the window, got ${status}`,
  );
});

test("a last_verified within the future-skew tolerance passes (age === -FUTURE_SKEW_TOLERANCE_DAYS)", () => {
  const status = assessStaleness(-FUTURE_SKEW_TOLERANCE_DAYS);
  assert(
    status === "ok",
    `expected 'ok' at the future-tolerance boundary, got ${status}`,
  );
});

test("a last_verified beyond the future-skew tolerance fails (age === -FUTURE_SKEW_TOLERANCE_DAYS - 1)", () => {
  const status = assessStaleness(-FUTURE_SKEW_TOLERANCE_DAYS - 1);
  assert(
    status === "future",
    `expected 'future' beyond the tolerance, got ${status}`,
  );
});

// ── canonical-context discovery ───────────────────────────────────────────────
//
// check-agent-context.mjs derives the enforced set by discovery: tracked
// markdown in the discovery roots with `canonical: true` frontmatter. These
// tests drive discoverCanonicalFiles with a synthetic file map (same reader
// contract the script uses), so a new canonical file can't escape the policy
// and a stripped-frontmatter core file can't silently drop out.

console.log("\ncanonical-context discovery");

const canonicalContent =
  "---\ntitle: T\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-03\n---\n\n# T\n";

function discoverFrom(files) {
  return discoverCanonicalFiles(Object.keys(files), (file) => files[file]);
}

test("discovers a canonical file in a nested docs path", () => {
  const discovered = discoverFrom({
    "docs/notes/deep/topology.md": canonicalContent,
  });
  assert(
    discovered.includes("docs/notes/deep/topology.md"),
    `expected nested docs file to be discovered, got ${JSON.stringify(discovered)}`,
  );
});

test("discovers AGENTS.md in any package directory", () => {
  const discovered = discoverFrom({
    "alerts/AGENTS.md": canonicalContent,
    "integration-probes/AGENTS.md": canonicalContent,
  });
  assert(
    discovered.length === 2,
    `expected both package AGENTS.md files, got ${JSON.stringify(discovered)}`,
  );
});

test("does not enforce non-canonical files", () => {
  const discovered = discoverFrom({
    "docs/guide.md":
      "---\ntitle: G\nstatus: active\nowner: eng\ncanonical: false\n---\n",
    "docs/plain.md": "# no frontmatter\n",
  });
  assert(
    discovered.length === 0,
    `expected non-canonical files to be skipped, got ${JSON.stringify(discovered)}`,
  );
});

test("ignores canonical frontmatter outside the discovery roots", () => {
  const discovered = discoverFrom({
    "ui-dashboard/README.md": canonicalContent,
  });
  assert(
    discovered.length === 0,
    `expected files outside the discovery roots to be skipped, got ${JSON.stringify(discovered)}`,
  );
});

test("minimum-presence fires when a core file loses its frontmatter", () => {
  const discovered = discoverFrom({
    "AGENTS.md": "# frontmatter stripped\n",
    "SPEC.md": canonicalContent,
  });
  const missing = missingCoreContextFiles(["AGENTS.md", "SPEC.md"], discovered);
  assert(
    missing.length === 1 && missing[0] === "AGENTS.md",
    `expected AGENTS.md to be reported missing, got ${JSON.stringify(missing)}`,
  );
});

test("minimum-presence passes when every core file is discovered", () => {
  const discovered = discoverFrom({
    "AGENTS.md": canonicalContent,
    "SPEC.md": canonicalContent,
  });
  const missing = missingCoreContextFiles(["AGENTS.md", "SPEC.md"], discovered);
  assert(
    missing.length === 0,
    `expected no missing core files, got ${JSON.stringify(missing)}`,
  );
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
