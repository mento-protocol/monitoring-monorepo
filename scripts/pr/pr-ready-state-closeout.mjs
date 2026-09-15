// The CodeRabbit closeout gate: when a missing or stale CodeRabbit signal may
// be answered with one `@coderabbitai review` request, and when the agent must
// wait instead. Requests bind to a head SHA and each one bills a review, so
// the gate orders the waits by the review each one would waste. It is advisory
// (`required: false`): a wrong answer costs at most one extra request.
//
// The head-time helpers live here because the grace wait is their only
// consumer besides the probe.

import { parseTimestamp } from "./pr-ready-state-review-signals.mjs";

// One opening closeout request plus one after the fixes. Each extra request
// bills another review, and a request posted while one runs supersedes and
// wastes it.
export const CODERABBIT_REVIEW_REQUEST_BUDGET = 2;
// A fresh head still draws its automatic run (the opening review, or the full
// re-review a base merge draws). Requesting inside that window buys a billed
// review the vendor would have run for free.
export const CODERABBIT_HEAD_GRACE_MS = 5 * 60 * 1000;

function validIsoTimestamp(value) {
  return Number.isFinite(Date.parse(value ?? "")) ? value : null;
}

function timelineEventTimestamp(item) {
  return (
    validIsoTimestamp(item?.created_at) ??
    validIsoTimestamp(item?.submitted_at) ??
    validIsoTimestamp(item?.updated_at) ??
    null
  );
}

export function headUpdatedAtFromTimeline(timelineItems = [], headSha) {
  const normalizedHeadSha = String(headSha ?? "").toLowerCase();
  if (!normalizedHeadSha) return null;

  let headCommitIndex = -1;
  let headCommitTimestamp = null;
  for (const [index, item] of timelineItems.entries()) {
    if (
      item?.event === "committed" &&
      String(item.sha ?? "").toLowerCase() === normalizedHeadSha
    ) {
      headCommitIndex = index;
      headCommitTimestamp = timelineEventTimestamp(item);
    }
  }
  if (headCommitIndex < 0) return null;
  if (headCommitTimestamp) return headCommitTimestamp;

  for (const item of timelineItems.slice(headCommitIndex + 1)) {
    const timestamp = timelineEventTimestamp(item);
    if (timestamp) return timestamp;
  }
  return null;
}

export function fetchHeadUpdatedAt({ headSha, timelineItems, observedAt }) {
  const timelineTimestamp = headUpdatedAtFromTimeline(timelineItems, headSha);
  const statusTimestamp = validIsoTimestamp(observedAt);
  if (!timelineTimestamp) return statusTimestamp;
  if (!statusTimestamp) return timelineTimestamp;
  return Date.parse(statusTimestamp) < Date.parse(timelineTimestamp)
    ? statusTimestamp
    : timelineTimestamp;
}

function nonNegativeCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function normalizeEpochMs(value) {
  if (Number.isFinite(value)) return value;
  return parseTimestamp(value);
}

function codeRabbitCloseoutFallbackAction(
  state,
  {
    mergeStateStatus,
    requiredStatusChecksStrict,
    reviewRunning,
    headUpdatedAt,
    observedAt,
    requestCount,
    requestBudget,
  },
) {
  if (!["missing", "stale"].includes(state)) return "wait";
  // A conflicted PR (DIRTY) always needs the base merged before anything else
  // can be reviewed. A BEHIND PR needs it too whenever BEHIND is still a
  // required blocker in `pr-ready-state-core.mjs` — i.e. until the base's
  // ruleset confirms `requiredStatusChecksStrict: false` (operator decision
  // 2026-09-15, ADR 0104); a request now would still be wasted once the base
  // merge that BEHIND requires eventually happens. Only once strict is
  // confirmed off does BEHIND stop forcing a base merge here too.
  const normalizedMergeState = String(mergeStateStatus ?? "")
    .trim()
    .toUpperCase();
  if (
    normalizedMergeState === "DIRTY" ||
    (normalizedMergeState === "BEHIND" && requiredStatusChecksStrict !== false)
  ) {
    return "merge_base_first";
  }
  // A new request supersedes the running review; the vendor bills the
  // superseded run and discards it.
  if (reviewRunning) return "wait_for_running_review";
  // A fresh head still draws its automatic run. An unknown head age cannot
  // rule that run out, so it fails closed on the cheaper wait.
  if (
    headUpdatedAt === null ||
    observedAt - headUpdatedAt < CODERABBIT_HEAD_GRACE_MS
  ) {
    return "wait_for_head_grace";
  }
  if (requestCount >= requestBudget) return "request_budget_exhausted";
  return "request_review_once_for_head";
}

export function summarizeCodeRabbitReviewGate(
  state,
  pathFilterSkip = null,
  context = {},
) {
  const requestCount = nonNegativeCount(context?.requestCount, 0);
  const requestBudget = nonNegativeCount(
    context?.requestBudget,
    CODERABBIT_REVIEW_REQUEST_BUDGET,
  );

  return {
    ready: ["reviewed", "not_applicable"].includes(state),
    required: false,
    state,
    fallbackAction: codeRabbitCloseoutFallbackAction(state, {
      mergeStateStatus: context?.mergeStateStatus ?? null,
      requiredStatusChecksStrict: context?.requiredStatusChecksStrict ?? null,
      reviewRunning: Boolean(context?.reviewRunning),
      headUpdatedAt: normalizeEpochMs(context?.headUpdatedAt),
      observedAt: normalizeEpochMs(context?.observedAt) ?? Date.now(),
      requestCount,
      requestBudget,
    }),
    requestCount,
    requestBudget,
    ...(state === "not_applicable" ? pathFilterSkip : {}),
  };
}
