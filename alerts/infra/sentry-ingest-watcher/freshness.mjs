// Pure parsing and freshness helpers for the Sentry triage ingest dead-man
// switch. Kept free of I/O so `node --test` can cover every failure path.
//
// Every failure path resolves toward "stale": callers receive `ok: false` and
// must publish nothing, so the freshness series goes absent and the absence
// condition in alerts/infra/monitoring.tf fires. Returning a fresh-looking
// value for a malformed response would silently disarm the switch, which is
// the exact failure this watcher exists to catch.

const SUCCESS_CONCLUSION = "success";

/**
 * Pick the newest successful run from a GitHub workflow-runs response.
 *
 * @param {unknown} payload Parsed body of
 *   `GET /repos/{owner}/{repo}/actions/workflows/{file}/runs`.
 * @returns {{ok: true, completedAtMs: number} | {ok: false, reason: string}}
 */
export function parseLatestSuccessfulRun(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, reason: "response_not_an_object" };
  }

  const runs = /** @type {{workflow_runs?: unknown}} */ (payload).workflow_runs;
  if (!Array.isArray(runs)) {
    return { ok: false, reason: "workflow_runs_missing" };
  }

  let newestMs = null;
  for (const run of runs) {
    if (run === null || typeof run !== "object") {
      continue;
    }
    if (run.conclusion !== SUCCESS_CONCLUSION) {
      continue;
    }
    if (typeof run.updated_at !== "string") {
      continue;
    }
    const completedAtMs = Date.parse(run.updated_at);
    if (!Number.isFinite(completedAtMs)) {
      continue;
    }
    if (newestMs === null || completedAtMs > newestMs) {
      newestMs = completedAtMs;
    }
  }

  if (newestMs === null) {
    return { ok: false, reason: "no_successful_run" };
  }
  return { ok: true, completedAtMs: newestMs };
}

/**
 * Seconds elapsed since the last successful run, floored at zero so clock skew
 * between GitHub and GCP cannot produce a negative gauge value.
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
