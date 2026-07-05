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
 * Classify a `last_verified` age (in days, as returned by `daysSince`)
 * against the staleness policy window. This is the pure decision logic
 * behind check-agent-context.mjs's `requireMetadata` future/stale checks,
 * extracted so the comparisons themselves get direct regression coverage.
 * @param {number} age
 * @param {{staleAfterDays?: number, toleranceDays?: number}} [options]
 * @returns {"ok" | "stale" | "future"}
 */
export function assessStaleness(
  age,
  {
    staleAfterDays = STALE_AFTER_DAYS,
    toleranceDays = FUTURE_SKEW_TOLERANCE_DAYS,
  } = {},
) {
  if (age < -toleranceDays) return "future";
  if (age > staleAfterDays) return "stale";
  return "ok";
}

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
 * Whether a tracked file path is eligible for canonical-context discovery.
 * Discovery roots: AGENTS.md and SPEC.md at the repo root, AGENTS.md in any
 * directory, docs markdown at any depth, and .agents markdown (skills,
 * roles). Mirrors under .claude/skills are excluded on purpose: the checker
 * enforces byte-parity between each mirror and its canonical .agents source,
 * so their metadata is already enforced transitively.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isCanonicalDiscoveryPath(filePath) {
  return (
    filePath === "AGENTS.md" ||
    filePath === "SPEC.md" ||
    filePath.endsWith("/AGENTS.md") ||
    (filePath.startsWith("docs/") && filePath.endsWith(".md")) ||
    (filePath.startsWith(".agents/") && filePath.endsWith(".md"))
  );
}

/**
 * Discover the canonical (frontmatter-managed) context files: every path in
 * `filePaths` that sits in a discovery root and whose frontmatter declares
 * `canonical: true`. This derives the enforced set from the repo itself so
 * new canonical files can't silently escape the staleness policy.
 * @param {string[]} filePaths
 * @param {(filePath: string) => string} readFile
 * @returns {string[]}
 */
export function discoverCanonicalFiles(filePaths, readFile) {
  return filePaths.filter((filePath) => {
    if (!isCanonicalDiscoveryPath(filePath)) return false;
    const data = parseFrontmatter(readFile(filePath));
    return data?.canonical === "true";
  });
}

/**
 * Core context files that discovery failed to find. Discovery derives the
 * enforced set from `canonical: true` frontmatter, so stripping a file's
 * frontmatter would otherwise silently unmanage it — the caller fails the
 * check for every file returned here.
 * @param {string[]} coreFiles
 * @param {string[]} discoveredFiles
 * @returns {string[]}
 */
export function missingCoreContextFiles(coreFiles, discoveredFiles) {
  const discovered = new Set(discoveredFiles);
  return coreFiles.filter((file) => !discovered.has(file));
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
