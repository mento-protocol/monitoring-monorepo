/**
 * Pure helpers for check-agent-context.mjs.
 * Extracted as a separate module so the script and its test file can both
 * import the real implementations instead of duplicating them — the main
 * script scans live repo state (git ls-files, real settings/hook files) and
 * isn't a good target for end-to-end fixture tests.
 */

/**
 * Number of days a canonical file's `last_verified` may age before
 * check-agent-context.mjs treats it as stale.
 */
export const STALE_AFTER_DAYS = 90;

/**
 * Tolerance, in days, for a `last_verified` date that resolves to appearing
 * one UTC day in the future. `daysSince` compares a UTC-midnight date
 * against the check's UTC clock, so a contributor in a timezone ahead of
 * UTC (up to UTC+14) who stamps their own local "today" can see it land on
 * UTC "tomorrow" until UTC midnight arrives. One day of slack absorbs the
 * maximum real-world skew without weakening the future-date guard against
 * genuinely bogus dates (a real typo lands further out than this).
 */
export const FUTURE_SKEW_TOLERANCE_DAYS = 1;

/**
 * Parse the YAML-ish frontmatter block (`---\nkey: value\n---`) from a
 * file's content. Returns null when the content has no frontmatter block.
 * @param {string} content
 * @returns {Record<string, string> | null}
 */
export function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  const data = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return data;
}

/**
 * Days elapsed between a `YYYY-MM-DD` date string and `now`. Returns null
 * when `dateString` isn't a strict `YYYY-MM-DD` date — including calendar
 * dates that don't exist (e.g. `2026-02-31`), which `Date.UTC` would
 * otherwise silently normalize into the following month instead of
 * rejecting.
 * @param {string} dateString
 * @param {Date} [now]
 * @returns {number | null}
 */
export function daysSince(dateString, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  const diffMs = now.getTime() - parsed.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}
