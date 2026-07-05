#!/usr/bin/env node
/**
 * Unit tests for scripts/check-agent-context.mjs.
 *
 * The script itself scans live repo state (git ls-files, real settings/hook
 * files) and exits the process on failure, so it isn't a good target for a
 * synthetic-fixture end-to-end harness. Instead this tests the pure parsing
 * and staleness helpers from check-agent-context-helpers.mjs directly.
 *
 * Run: node scripts/check-agent-context.test.mjs
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import {
  daysSince,
  FUTURE_SKEW_TOLERANCE_DAYS,
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

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
