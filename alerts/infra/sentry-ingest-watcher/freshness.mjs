// Pure parsing and freshness helpers for the Sentry triage ingest dead-man
// switch. Kept free of I/O so `node --test` can cover every failure path.
//
// Every failure path resolves toward "stale": callers receive `ok: false` and
// must publish nothing, so the freshness series goes absent and the absence
// condition in alerts/infra/monitoring.tf fires. Returning a fresh-looking
// value for a malformed response would silently disarm the switch, which is
// the exact failure this watcher exists to catch.

// The rolling run record `scripts/sentry/triage/sentry-triage-ingest.mjs` posts on tracker
// issue #1282. Pinned to the exact version: this watcher reads the record's
// body as a contract, so a `v2` bump must fail closed and alert rather than
// keep parsing a field whose meaning has quietly changed. `RUN_RECORD_MARKER`
// in that script names this reader.
export const RUN_RECORD_MARKER = "<!-- sentry-triage-ingest:run-record:v1 -->";

// Mirrors `TRUSTED_COMMENT_AUTHORS` in scripts/sentry/triage/sentry-triage-project-core.mjs.
// This repository is public and #1282 is open, so without an author fence any
// drive-by commenter could post a marker-bearing comment carrying a fresh
// timestamp and hold the gauge green over a dead pipeline. The GraphQL shape
// renders the login as `github-actions` and REST as `github-actions[bot]`;
// accept both. A missing or unknown author is untrusted.
export const TRUSTED_RUN_RECORD_AUTHORS = [
  "github-actions",
  "github-actions[bot]",
];

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u;

/**
 * Pick the newest trusted ingest run record from a GitHub issue-comments
 * response.
 *
 * The timestamp comes from the record's **body**, never from the comment's
 * `created_at` or `updated_at`. Those move on any mutation of the comment
 * object, so a metadata edit would drive the gauge fresh while the pipeline
 * stayed dead. The body timestamp is written by the ingest itself after the
 * ingest loop finished, and only on a run that actually fetched and counted
 * issues — a run that no-ops on the kill switch or a missing
 * `SENTRY_TRIAGE_TOKEN` returns before the record is posted. That makes it
 * evidence of work rather than evidence of exit code 0.
 *
 * @param {unknown} payload Parsed body of
 *   `GET /repos/{owner}/{repo}/issues/{number}/comments`.
 * @returns {{ok: true, completedAtMs: number} | {ok: false, reason: string}}
 */
export function parseLatestRunRecord(payload) {
  if (!Array.isArray(payload)) {
    return { ok: false, reason: "response_not_an_array" };
  }

  let newestMs = null;
  let sawTrustedRecord = false;
  for (const comment of payload) {
    if (comment === null || typeof comment !== "object") {
      continue;
    }
    const login = comment.user?.login;
    if (
      typeof login !== "string" ||
      !TRUSTED_RUN_RECORD_AUTHORS.includes(login)
    ) {
      continue;
    }
    if (
      typeof comment.body !== "string" ||
      !comment.body.startsWith(RUN_RECORD_MARKER)
    ) {
      continue;
    }
    sawTrustedRecord = true;
    const match = ISO_INSTANT.exec(comment.body);
    if (match === null) {
      continue;
    }
    const completedAtMs = Date.parse(match[0]);
    if (!Number.isFinite(completedAtMs)) {
      continue;
    }
    if (newestMs === null || completedAtMs > newestMs) {
      newestMs = completedAtMs;
    }
  }

  if (newestMs === null) {
    return {
      ok: false,
      reason: sawTrustedRecord
        ? "run_record_timestamp_unreadable"
        : "no_trusted_run_record",
    };
  }
  return { ok: true, completedAtMs: newestMs };
}

/**
 * Seconds elapsed since the ingest last recorded work, floored at zero so clock
 * skew between the ingest runner and GCP cannot produce a negative gauge.
 *
 * @param {number} completedAtMs
 * @param {number} nowMs
 * @returns {number | null} null when either input is not a finite timestamp.
 */
export function freshnessSeconds(completedAtMs, nowMs) {
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - completedAtMs) / 1000));
}
