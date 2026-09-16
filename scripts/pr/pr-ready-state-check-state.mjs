/**
 * Read a single status check's state: which checks are advisory, how a
 * conclusion maps to pass/fail/pending/skipped, how two runs of the same check
 * are identified and ordered, and how a whole rollup groups.
 *
 * Split out of pr-ready-state-core.mjs (docs/pr-checklists/recurring-review-patterns.md
 * "File-size budget"). This module imports nothing from the oracle, so the
 * base-health read can reuse the same classification the PR's own checks get.
 */
export const OPTIONAL_CHECK_NAMES = new Set([
  // CodeRabbit is advisory and reports SUCCESS when a rate-limited review never
  // ran. Report its lag, but read review evidence instead of its conclusion.
  "CodeRabbit",
  "Core Web Vitals + accessibility (ui-dashboard)",
  "GraphQL schema diff",
  "jscpd",
]);

const PASS_VALUES = new Set(["SUCCESS", "PASSED", "PASS"]);
const FAIL_VALUES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAIL",
  "FAILED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const PENDING_VALUES = new Set([
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const SKIPPED_VALUES = new Set(["NEUTRAL", "SKIPPED"]);

export function normalizeStatusValue(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

export function checkDisplayName(check) {
  return (
    check.name ??
    check.context ??
    check.workflowName ??
    check.app?.name ??
    check.__typename ??
    "unknown check"
  );
}

export function isOptionalCheckName(name) {
  return OPTIONAL_CHECK_NAMES.has(name);
}

export function classifyCheck(check) {
  const values = [
    check.conclusion,
    check.state,
    check.status,
    check.rollupStatus,
  ].map(normalizeStatusValue);

  if (values.some((value) => FAIL_VALUES.has(value))) return "fail";
  if (values.some((value) => PENDING_VALUES.has(value))) return "pending";
  if (values.some((value) => SKIPPED_VALUES.has(value))) return "skipped";
  if (values.some((value) => PASS_VALUES.has(value))) return "pass";

  return "pending";
}

export function checkRunOrderTimestampMs(check) {
  // Use startedAt so delayed cancellation completion does not make a stale
  // run appear newer than the passing run that superseded it.
  const timestamp = check.startedAt ?? check.completedAt ?? null;
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function checkIdentity(check) {
  const appId =
    check.appId ?? check.app_id ?? check.app?.id ?? check.app?.databaseId ?? "";
  return [
    checkDisplayName(check),
    check.workflowName ?? check.workflow_name ?? "",
    appId,
  ].join("\0");
}

export function suppressSupersededCancelledChecks(statusCheckRollup = []) {
  const latestPassingTimeByIdentity = new Map();

  for (const check of statusCheckRollup) {
    if (classifyCheck(check) !== "pass") continue;
    const timestampMs = checkRunOrderTimestampMs(check);
    if (timestampMs === null) continue;
    const identity = checkIdentity(check);
    const previous = latestPassingTimeByIdentity.get(identity) ?? -Infinity;
    if (timestampMs > previous) {
      latestPassingTimeByIdentity.set(identity, timestampMs);
    }
  }

  return statusCheckRollup.filter((check) => {
    if (normalizeStatusValue(check.conclusion) !== "CANCELLED") return true;
    const timestampMs = checkRunOrderTimestampMs(check);
    if (timestampMs === null) return true;
    const newerPassingTime = latestPassingTimeByIdentity.get(
      checkIdentity(check),
    );
    return newerPassingTime === undefined || newerPassingTime <= timestampMs;
  });
}

export function groupStatusChecks(statusCheckRollup = []) {
  const grouped = {
    pass: [],
    fail: [],
    pending: [],
    skipped: [],
  };

  for (const check of suppressSupersededCancelledChecks(statusCheckRollup)) {
    const group = classifyCheck(check);
    grouped[group].push({
      name: checkDisplayName(check),
      status: check.status ?? check.state ?? null,
      conclusion: check.conclusion ?? null,
      detailsUrl: check.detailsUrl ?? check.targetUrl ?? null,
    });
  }

  for (const checks of Object.values(grouped)) {
    checks.sort((a, b) => a.name.localeCompare(b.name));
  }

  return grouped;
}
