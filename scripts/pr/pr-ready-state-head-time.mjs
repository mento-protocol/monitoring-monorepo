// Head-time evidence for the PR ready-state oracle: when the current head
// was pushed, how sure that time is, and the floors that bound a head's age
// from below (PR creation, the latest ready-for-review event). Split from
// pr-ready-state-review-signals.mjs, which classifies review signals against
// these times.

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

function headCommitTimelineEntry(timelineItems = [], headSha) {
  const normalizedHeadSha = String(headSha ?? "").toLowerCase();
  if (!normalizedHeadSha) return { index: -1, timestamp: null };
  let index = -1;
  let timestamp = null;
  for (const [itemIndex, item] of timelineItems.entries()) {
    if (
      item?.event === "committed" &&
      String(item.sha ?? "").toLowerCase() === normalizedHeadSha
    ) {
      index = itemIndex;
      timestamp = timelineEventTimestamp(item);
    }
  }
  return { index, timestamp };
}

/**
 * The head commit's own timeline timestamp, or null. Unlike
 * `headUpdatedAtFromTimeline`, this never substitutes a later event, so a
 * null here means every other head time is only an upper bound.
 */
export function headCommitTimestampFromTimeline(timelineItems = [], headSha) {
  return headCommitTimelineEntry(timelineItems, headSha).timestamp;
}

export function headUpdatedAtFromTimeline(timelineItems = [], headSha) {
  const { index, timestamp } = headCommitTimelineEntry(timelineItems, headSha);
  if (index < 0) return null;
  if (timestamp) return timestamp;

  for (const item of timelineItems.slice(index + 1)) {
    const later = timelineEventTimestamp(item);
    if (later) return later;
  }
  return null;
}

function earliestIsoTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

/** The latest `ready_for_review` event: with drafts unreviewed, review starts there. */
export function readyForReviewAtFromTimeline(timelineItems = []) {
  let latest = null;
  for (const item of timelineItems) {
    if (item?.event !== "ready_for_review") continue;
    const timestamp = validIsoTimestamp(item.created_at);
    if (timestamp && (!latest || Date.parse(timestamp) > Date.parse(latest))) {
      latest = timestamp;
    }
  }
  return latest;
}

function latestIsoTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * True when the head time `fetchHeadUpdatedAt` selects is not the head
 * commit's own timeline timestamp: a later timeline event, the first check on
 * the head, and the activation floor (PR creation, ready-for-review) all land
 * after the push, so the selected time only bounds the push from above and
 * cannot bound requests from below.
 */
export function headUpdatedAtIsUpperBound({
  headSha,
  timelineItems,
  observedAt,
  openedAt = null,
}) {
  const commitTimestamp = headCommitTimestampFromTimeline(
    timelineItems,
    headSha,
  );
  const selected = fetchHeadUpdatedAt({
    headSha,
    timelineItems,
    observedAt,
    openedAt,
  });
  if (!selected) return false;
  return (
    !commitTimestamp || Date.parse(selected) !== Date.parse(commitTimestamp)
  );
}

export function fetchHeadUpdatedAt({
  headSha,
  timelineItems,
  observedAt,
  openedAt = null,
}) {
  const timelineTimestamp = headUpdatedAtFromTimeline(timelineItems, headSha);
  const statusTimestamp = validIsoTimestamp(observedAt);
  const evidence = earliestIsoTimestamp(timelineTimestamp, statusTimestamp);
  if (!evidence) return null;
  // A branch pushed before its PR opened, or while the PR was a draft, carries
  // commit and check timestamps older than the moment review could start. The
  // automatic review starts when the PR opens or is marked ready, so the later
  // of those is a floor for the head's age. With no other evidence the head's
  // real age stays unknown, and the caller fails closed.
  const activationFloor = latestIsoTimestamp(
    validIsoTimestamp(openedAt),
    readyForReviewAtFromTimeline(timelineItems),
  );
  return latestIsoTimestamp(evidence, activationFloor);
}

/**
 * The head time the probe annotates a PR with, whether that time is only an
 * upper bound, and whether the head's age is known well enough for the
 * closeout grace decision. When the selected time is not the head commit's
 * own timeline timestamp the pending-request wait cannot use it as a lower
 * bound for requests and a marked request keeps counting. A null
 * `timelineItems` means the timeline read failed: the latest ready-for-review
 * event is then unknown, so a status time older than the grace window may
 * still be a fresh activation. The age stays unknown for the grace decision
 * while the time itself keeps bounding the required review signals, which
 * fail closed on a null time.
 */
export function headTimeForPullRequest({
  headSha,
  timelineItems,
  observedAt,
  openedAt = null,
}) {
  const timelineAvailable = Array.isArray(timelineItems);
  const items = timelineAvailable ? timelineItems : [];
  const headUpdatedAt = fetchHeadUpdatedAt({
    headSha,
    timelineItems: items,
    observedAt,
    openedAt,
  });
  return {
    headUpdatedAt,
    headUpdatedAtIsUpperBound:
      headUpdatedAt !== null &&
      headUpdatedAtIsUpperBound({
        headSha,
        timelineItems: items,
        observedAt,
        openedAt,
      }),
    headFreshnessKnown: timelineAvailable && headUpdatedAt !== null,
  };
}
