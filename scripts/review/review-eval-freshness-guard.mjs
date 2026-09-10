/**
 * Freshness-workflow helpers: the monthly staleness-issue planner and the
 * guard that restricts live issue creation to the scheduled workflow. Split
 * out of `review-eval-run-score.mjs` for line headroom; the barrel
 * `review-eval-run.mjs` re-exports both, so importers are unchanged.
 */

/**
 * One staleness issue per contract per month, deduplicated by the marker block
 * the documentation schedulers already use.
 */
export function planStalenessIssueSync({
  month,
  contractDigest,
  issues,
  payload,
}) {
  const tracked = (issues ?? []).filter((issue) => issue.marker);
  const open = tracked.find((issue) => issue.state !== "CLOSED");
  if (open) {
    return {
      action:
        open.marker.month === month &&
        open.marker.contract_digest === contractDigest
          ? "keep-current"
          : "skip-prior-open",
      reason: `issue #${open.number} for ${open.marker.month} is still open`,
      issue: open,
    };
  }
  const closed = tracked.find(
    (issue) =>
      issue.marker.month === month &&
      issue.marker.contract_digest === contractDigest,
  );
  if (closed) {
    return {
      action: "skip-complete",
      reason: `${month} is already covered by closed issue #${closed.number}`,
      issue: closed,
    };
  }
  return {
    action: "create",
    reason: `no open or completed staleness issue exists for ${month}`,
    payload,
  };
}

// The scheduled workflow always runs on the default branch, so the ref is a
// constant here. Comparing GITHUB_WORKFLOW_REF against GITHUB_REF would put
// the same runtime value on both sides of the test and constrain nothing.
export const FRESHNESS_WORKFLOW_REF = "refs/heads/main";

/**
 * Live issue creation belongs to the scheduled freshness workflow alone. Every
 * other caller plans the synchronization and prints it. `workflow_dispatch` is
 * not accepted: a dispatch can name any branch, and an unattended issue write
 * from an arbitrary branch is exactly what this guard exists to refuse.
 */
export function assertAuthorizedFreshnessWorkflow(
  options,
  { env = process.env } = {},
) {
  const expected = `${options.repo}/.github/workflows/review-eval-freshness.yml@${FRESHNESS_WORKFLOW_REF}`;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    String(env.GITHUB_EVENT_NAME ?? "") !== "schedule" ||
    String(env.GITHUB_REF ?? "") !== FRESHNESS_WORKFLOW_REF ||
    String(env.GITHUB_WORKFLOW_REF ?? "") !== expected
  ) {
    throw new Error(
      `live issue creation is restricted to the review-eval freshness workflow on its schedule (${FRESHNESS_WORKFLOW_REF}); use --dry-run locally`,
    );
  }
}
