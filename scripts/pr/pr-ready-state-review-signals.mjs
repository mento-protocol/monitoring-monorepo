export const BOT_APPROVER = "chatgpt-codex-connector[bot]";
const BOT_APPROVER_LOGIN = "chatgpt-codex-connector";
const CODERABBIT_AUTHORS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const CODERABBIT_REQUEST_AUTHORS = new Set([
  BOT_APPROVER,
  BOT_APPROVER_LOGIN,
  "claude",
  "claude[bot]",
]);
const CODERABBIT_REQUEST_ASSOCIATIONS = new Set([
  "COLLABORATOR",
  "MEMBER",
  "OWNER",
]);
const CODERABBIT_REVIEW_RUN_MARKER = /\*\*Run ID\*\*:\s*`[^`\r\n]+`/i;
const CODERABBIT_RECENT_REVIEW_BLOCK =
  /<!--\s*recent_review_start\s*-->([\s\S]*?)<!--\s*recent_review_end\s*-->/gi;
const CODERABBIT_CLEAN_REVIEW_SUMMARY =
  /No actionable comments were generated in the recent review\./i;
const CODERABBIT_REVIEW_COMMIT_RANGE =
  /\bbetween\s+[0-9a-f]{40}\s+and\s+([0-9a-f]{40})(?![0-9a-f])/gi;
const CODERABBIT_FINAL_HEAD_REQUEST_MARKER =
  /<!--\s*coderabbit-final-head-review:([0-9a-f]{40})\s*-->/i;
const CODERABBIT_REVIEW_REQUEST_COMMAND =
  /(^|\s)@coderabbitai\s+(?:full\s+)?review\b/i;
// One opening closeout request plus one after the fixes. Each extra request
// bills another review, and a request posted while one runs supersedes and
// wastes it.
export const CODERABBIT_REVIEW_REQUEST_BUDGET = 2;
// CodeRabbit refills its request allowance hourly. A bare request posted inside
// that hour still runs or is rate-limited; posting again supersedes it.
export const CODERABBIT_PENDING_REQUEST_WINDOW_MS = 60 * 60 * 1000;
// A push usually draws an automatic run within a few minutes. Requesting inside
// that window buys a billed review the vendor would have run for free.
export const CODERABBIT_HEAD_GRACE_MS = 5 * 60 * 1000;
const CODERABBIT_SUMMARY_MARKER =
  /<!--\s*This is an auto-generated comment:\s*summarize by coderabbit\.ai\s*-->/gi;
const CODERABBIT_SKIP_REVIEW_MARKER =
  /<!--\s*This is an auto-generated comment:\s*skip review by coderabbit\.ai\s*-->/gi;
const CODERABBIT_SKIP_REVIEW_END_MARKER =
  /<!--\s*end of auto-generated comment:\s*skip review by coderabbit\.ai\s*-->/gi;
const CODERABBIT_PATH_FILTER_SKIP_TEXT =
  /^\s*>\s*Review was skipped due to path filters\s*$/gim;
const CODERABBIT_IGNORED_FILES_BLOCK =
  /<summary>\s*:no_entry:\s*Files ignored due to path filters\s*\((\d+)\)<\/summary>([\s\S]*?)<\/details>/gi;
const CODERABBIT_IGNORED_FILE =
  /^\s*>\s*\*\s+`([^`\r\n]+)`\s+is excluded by\s+`[^`\r\n]+`\s*$/gim;

export function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? null : timestamp;
}

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

function isAtOrAfter(timestamp, lowerBound) {
  const parsed = parseTimestamp(timestamp);
  const parsedLowerBound = Number.isFinite(lowerBound)
    ? lowerBound
    : parseTimestamp(lowerBound);
  return (
    parsed !== null && parsedLowerBound !== null && parsed >= parsedLowerBound
  );
}

function isCurrentSignal(timestamp, lowerBound) {
  if (lowerBound === null) return true;
  return isAtOrAfter(timestamp, lowerBound);
}

function reviewCommitOid(review) {
  return (
    review.commit?.oid ??
    review.commit?.sha ??
    review.commitId ??
    review.commit_id ??
    null
  );
}

function isCurrentReviewSignal(review, currentHeadOid, headUpdatedAt) {
  if (currentHeadOid) return reviewCommitOid(review) === currentHeadOid;

  const submittedAt =
    review.submittedAt ?? review.submitted_at ?? review.createdAt;
  return isCurrentSignal(submittedAt, headUpdatedAt);
}

export function isCodexReviewRequestBody(body) {
  return /(^|\s)@codex\s+review\b/i.test(String(body ?? ""));
}

function codeRabbitFinalHeadReviewRequestHead(body) {
  const text = String(body ?? "");
  // The same matcher counts requests against the budget, so a marked
  // `full review` is both counted and recognized as the current-head request.
  if (!CODERABBIT_REVIEW_REQUEST_COMMAND.test(text)) return null;
  return text.match(CODERABBIT_FINAL_HEAD_REQUEST_MARKER)?.[1] ?? null;
}

export function countTrustedCodeRabbitReviewRequests(issueComments = []) {
  return issueComments.filter(
    (comment) =>
      isTrustedCodeRabbitReviewRequestComment(comment) &&
      CODERABBIT_REVIEW_REQUEST_COMMAND.test(String(comment?.body ?? "")),
  ).length;
}

export function hasPendingBareCodeRabbitReviewRequest({
  issueComments = [],
  currentHeadOid = null,
  headUpdatedAt = null,
  observedAt = Date.now(),
} = {}) {
  const currentHead = String(currentHeadOid ?? "").toLowerCase();

  return issueComments.some((comment) => {
    if (!isTrustedCodeRabbitReviewRequestComment(comment)) return false;
    const body = String(comment?.body ?? "");
    if (!CODERABBIT_REVIEW_REQUEST_COMMAND.test(body)) return false;

    // A marker for the current head is the "requested" signal, not a pending
    // wait. A marker for another head belongs to a superseded push.
    const requestedHead = codeRabbitFinalHeadReviewRequestHead(body);
    if (requestedHead && requestedHead.toLowerCase() === currentHead) {
      return false;
    }

    const createdAt = comment?.created_at ?? comment?.createdAt ?? null;
    const timestamp = parseTimestamp(createdAt);
    if (timestamp === null) return false;
    if (headUpdatedAt !== null && !isAtOrAfter(createdAt, headUpdatedAt)) {
      return false;
    }
    return observedAt - timestamp < CODERABBIT_PENDING_REQUEST_WINDOW_MS;
  });
}

function isTrustedCodeRabbitReviewRequestComment(comment) {
  const association = String(
    comment.author_association ?? comment.authorAssociation ?? "",
  ).toUpperCase();
  if (CODERABBIT_REQUEST_ASSOCIATIONS.has(association)) return true;

  const author = comment.user?.login ?? comment.author?.login ?? null;
  return CODERABBIT_REQUEST_AUTHORS.has(String(author ?? "").toLowerCase());
}

function codeRabbitCompletedCleanReviewHeads(body) {
  const text = String(body ?? "");
  const reviewedHeads = new Set();

  for (const blockMatch of text.matchAll(CODERABBIT_RECENT_REVIEW_BLOCK)) {
    const block = blockMatch[1];
    if (!CODERABBIT_CLEAN_REVIEW_SUMMARY.test(block)) continue;
    if (!CODERABBIT_REVIEW_RUN_MARKER.test(block)) continue;

    for (const rangeMatch of block.matchAll(CODERABBIT_REVIEW_COMMIT_RANGE)) {
      reviewedHeads.add(rangeMatch[1].toLowerCase());
    }
  }

  return reviewedHeads;
}

function codeRabbitCommentTimestamp(comment) {
  return (
    comment.updated_at ??
    comment.updatedAt ??
    comment.created_at ??
    comment.createdAt ??
    null
  );
}

function singleMatch(body, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = [
    ...String(body ?? "").matchAll(new RegExp(pattern.source, flags)),
  ];
  return matches.length === 1 ? matches[0] : null;
}

function matchesInCanonicalOrder(matches) {
  return matches.every((match, index) => {
    if (index === 0) return true;
    const previous = matches[index - 1];
    return previous.index + previous[0].length <= match.index;
  });
}

function pathFilterSkipCandidate(comment, headUpdatedAt) {
  const author = comment.user?.login ?? comment.author?.login ?? null;
  if (!CODERABBIT_AUTHORS.has(String(author ?? "").toLowerCase())) {
    return null;
  }
  if (
    headUpdatedAt === null ||
    !isAtOrAfter(codeRabbitCommentTimestamp(comment), headUpdatedAt)
  ) {
    return null;
  }

  const body = String(comment.body ?? "");
  const summaryMatch = singleMatch(body, CODERABBIT_SUMMARY_MARKER);
  const skipStartMatch = singleMatch(body, CODERABBIT_SKIP_REVIEW_MARKER);
  const skipTextMatch = singleMatch(body, CODERABBIT_PATH_FILTER_SKIP_TEXT);
  const ignoredBlockMatch = singleMatch(body, CODERABBIT_IGNORED_FILES_BLOCK);
  const runMarkerMatch = singleMatch(body, CODERABBIT_REVIEW_RUN_MARKER);
  const skipEndMatch = singleMatch(body, CODERABBIT_SKIP_REVIEW_END_MARKER);
  if (
    !summaryMatch ||
    !skipStartMatch ||
    !skipTextMatch ||
    !ignoredBlockMatch ||
    !runMarkerMatch ||
    !skipEndMatch ||
    !matchesInCanonicalOrder([
      summaryMatch,
      skipStartMatch,
      skipTextMatch,
      ignoredBlockMatch,
      runMarkerMatch,
      skipEndMatch,
    ])
  ) {
    return null;
  }

  const declaredCount = Number(ignoredBlockMatch[1]);
  const ignoredPaths = [
    ...ignoredBlockMatch[2].matchAll(CODERABBIT_IGNORED_FILE),
  ]
    .map((match) => match[1])
    .filter(Boolean);
  const uniquePaths = new Set(ignoredPaths);
  if (
    !Number.isSafeInteger(declaredCount) ||
    declaredCount <= 0 ||
    ignoredPaths.length !== declaredCount ||
    uniquePaths.size !== declaredCount
  ) {
    return null;
  }

  const sourceUrl = comment.html_url ?? comment.url ?? null;
  if (!sourceUrl) return null;
  return {
    declaredCount,
    ignoredPaths,
    sourceUrl,
    observedAt: codeRabbitCommentTimestamp(comment),
  };
}

export function findCodeRabbitPathFilterSkipCandidate({
  issueComments = [],
  headUpdatedAt = null,
} = {}) {
  const candidates = issueComments
    .map((comment) => pathFilterSkipCandidate(comment, headUpdatedAt))
    .filter(Boolean)
    .sort(
      (left, right) =>
        (parseTimestamp(right.observedAt) ?? 0) -
        (parseTimestamp(left.observedAt) ?? 0),
    );
  return candidates[0] ?? null;
}

export function validateCodeRabbitPathFilterSkip({
  candidate = null,
  currentFiles = null,
  expectedChangedFileCount = null,
  filesComplete = false,
} = {}) {
  if (
    !candidate ||
    !filesComplete ||
    !Array.isArray(currentFiles) ||
    !Array.isArray(candidate.ignoredPaths) ||
    !candidate.sourceUrl
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(expectedChangedFileCount) ||
    expectedChangedFileCount <= 0 ||
    currentFiles.length !== expectedChangedFileCount
  ) {
    return null;
  }
  if (
    currentFiles.some(
      (path) => typeof path !== "string" || path.length === 0,
    ) ||
    new Set(currentFiles).size !== currentFiles.length ||
    candidate.declaredCount !== candidate.ignoredPaths.length ||
    candidate.declaredCount !== currentFiles.length ||
    new Set(candidate.ignoredPaths).size !== candidate.ignoredPaths.length
  ) {
    return null;
  }

  const ignoredPaths = [...candidate.ignoredPaths].sort((left, right) =>
    left.localeCompare(right),
  );
  const sortedCurrentFiles = [...currentFiles].sort((left, right) =>
    left.localeCompare(right),
  );
  if (ignoredPaths.some((path, index) => path !== sortedCurrentFiles[index])) {
    return null;
  }

  return {
    reason: "path_filters",
    sourceUrl: candidate.sourceUrl,
    ignoredPaths,
  };
}

function nonNegativeCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function codeRabbitCloseoutFallbackAction(
  state,
  {
    mergeStateStatus,
    reviewRunning,
    pendingRequest,
    headFreshnessKnown = true,
    headUpdatedAt,
    observedAt,
    requestCount,
    requestBudget,
  },
) {
  if (!["missing", "stale"].includes(state)) return "wait";
  // A base merge rewrites the head, so a request posted first is wasted and can
  // itself draw an unprompted full re-review.
  if (
    String(mergeStateStatus ?? "")
      .trim()
      .toUpperCase() === "BEHIND"
  ) {
    return "merge_base_first";
  }
  // A new request supersedes the running review; the vendor bills the
  // superseded run and discards it.
  if (reviewRunning) return "wait_for_running_review";
  // The request is in, but no check run has appeared yet. Posting again
  // supersedes it inside the same refill hour.
  if (pendingRequest) return "wait_for_pending_request";
  // The head's age is unknown, so its automatic run cannot be ruled out.
  // Waiting costs a poll; requesting can duplicate the opening or post-merge
  // review, so fail closed.
  if (!headFreshnessKnown) return "wait_for_head_grace";
  // A fresh head still draws its automatic run: the opening review, or the full
  // re-review a base merge or rebase triggers.
  if (
    headUpdatedAt !== null &&
    observedAt - headUpdatedAt < CODERABBIT_HEAD_GRACE_MS
  ) {
    return "wait_for_head_grace";
  }
  if (requestCount >= requestBudget) return "request_budget_exhausted";
  return "request_review_once_for_head";
}

function normalizeEpochMs(value) {
  if (Number.isFinite(value)) return value;
  return parseTimestamp(value);
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
      reviewRunning: Boolean(context?.reviewRunning),
      pendingRequest: Boolean(context?.pendingRequest),
      headFreshnessKnown: Boolean(context?.headFreshnessKnown ?? true),
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

export function isCodeRabbitFinalHeadReviewRequestBody(
  body,
  currentHeadOid = null,
) {
  const requestedHead = codeRabbitFinalHeadReviewRequestHead(body);
  if (!requestedHead) return false;
  if (!currentHeadOid) return true;
  return requestedHead.toLowerCase() === String(currentHeadOid).toLowerCase();
}

function isBotApproverLogin(login) {
  return login === BOT_APPROVER || login === BOT_APPROVER_LOGIN;
}

function commentReactionContent(reaction) {
  return String(reaction?.content ?? reaction ?? "").toLowerCase();
}

function hasCodexEyesReaction(comment, headUpdatedAt, fallbackCurrent = false) {
  const reactions = comment.reactions;
  const reactionNodes = Array.isArray(reactions)
    ? reactions
    : (reactions?.nodes ?? []);

  return reactionNodes.some((reaction) => {
    if (
      commentReactionContent(reaction) !== "eyes" ||
      !isBotApproverLogin(reaction?.user?.login)
    ) {
      return false;
    }

    if (headUpdatedAt === null) return true;

    const createdAt = parseTimestamp(reaction.created_at ?? reaction.createdAt);
    if (createdAt === null) return fallbackCurrent;
    return createdAt >= headUpdatedAt;
  });
}

export function hasCodexApprovalReaction(reactions = [], headUpdatedAt = null) {
  if (headUpdatedAt === null) return false;

  return reactions.some(
    (reaction) =>
      reaction.content === "+1" &&
      isBotApproverLogin(reaction.user?.login) &&
      parseTimestamp(reaction.created_at ?? reaction.createdAt) >=
        headUpdatedAt,
  );
}

export function hasCodexInFlightReaction(reactions = [], headUpdatedAt = null) {
  return reactions.some((reaction) => {
    if (
      commentReactionContent(reaction) !== "eyes" ||
      !isBotApproverLogin(reaction.user?.login)
    ) {
      return false;
    }
    if (headUpdatedAt === null) return true;

    const createdAt = parseTimestamp(reaction.created_at ?? reaction.createdAt);
    return createdAt !== null && createdAt >= headUpdatedAt;
  });
}

export function classifyCodexReviewSignal({
  issueComments = [],
  reviews = [],
  headUpdatedAt = null,
  currentHeadOid = null,
  codexApprovalReaction = false,
  codexInFlightReaction = false,
} = {}) {
  if (codexApprovalReaction) return "approved";
  if (codexInFlightReaction) return "in_flight";

  let hasHistoricalSignal = false;
  let hasCurrentRequest = false;
  let hasCurrentInFlightSignal = false;

  for (const comment of issueComments) {
    const author = comment.user?.login ?? comment.author?.login ?? null;
    const createdAt = comment.created_at ?? comment.createdAt;
    const isCurrent = isCurrentSignal(createdAt, headUpdatedAt);

    if (isBotApproverLogin(author) && isCurrent) {
      hasCurrentInFlightSignal = true;
    } else if (isBotApproverLogin(author)) {
      hasHistoricalSignal = true;
    }

    if (!isCodexReviewRequestBody(comment.body)) continue;

    if (isCurrent) {
      hasCurrentRequest = true;
      if (hasCodexEyesReaction(comment, headUpdatedAt, true)) {
        hasCurrentInFlightSignal = true;
      }
    } else {
      if (hasCodexEyesReaction(comment, headUpdatedAt)) {
        hasCurrentInFlightSignal = true;
      }
      hasHistoricalSignal = true;
    }
  }

  for (const review of reviews) {
    const author = review.author?.login ?? review.user?.login ?? null;
    if (!isBotApproverLogin(author)) continue;

    if (isCurrentReviewSignal(review, currentHeadOid, headUpdatedAt)) {
      hasCurrentInFlightSignal = true;
    } else {
      hasHistoricalSignal = true;
    }
  }

  if (hasCurrentInFlightSignal) return "in_flight";
  if (hasCurrentRequest) return "requested";
  if (hasHistoricalSignal) return "stale";
  return "missing";
}

export function classifyCodeRabbitReviewSignal({
  issueComments = [],
  reviews = [],
  currentHeadOid = null,
  headUpdatedAt = null,
  headUpdatedAtIsUpperBound = false,
  pathFilterSkip = null,
} = {}) {
  const currentHead = String(currentHeadOid ?? "").toLowerCase();
  let hasHistoricalSignal = false;
  let hasCurrentRequest = false;

  for (const review of reviews) {
    const author = review.author?.login ?? review.user?.login ?? null;
    if (!CODERABBIT_AUTHORS.has(String(author ?? "").toLowerCase())) continue;
    if (!CODERABBIT_REVIEW_RUN_MARKER.test(String(review.body ?? ""))) {
      continue;
    }

    if (
      currentHead &&
      String(reviewCommitOid(review) ?? "").toLowerCase() === currentHead
    ) {
      return "reviewed";
    }
    hasHistoricalSignal = true;
  }

  for (const comment of issueComments) {
    const author = comment.user?.login ?? comment.author?.login ?? null;
    if (!CODERABBIT_AUTHORS.has(String(author ?? "").toLowerCase())) continue;

    const reviewedHeads = codeRabbitCompletedCleanReviewHeads(comment.body);
    if (reviewedHeads.size === 0) continue;

    if (
      currentHead &&
      reviewedHeads.has(currentHead) &&
      headUpdatedAt !== null &&
      isAtOrAfter(codeRabbitCommentTimestamp(comment), headUpdatedAt)
    ) {
      return "reviewed";
    }
    hasHistoricalSignal = true;
  }

  if (pathFilterSkip) return "not_applicable";

  for (const comment of issueComments) {
    if (!isTrustedCodeRabbitReviewRequestComment(comment)) continue;
    const requestedHead = codeRabbitFinalHeadReviewRequestHead(comment.body);
    if (!requestedHead) continue;
    const matchesCurrentHead =
      currentHead && requestedHead.toLowerCase() === currentHead;

    // A head time taken from the first check on the head lands after the
    // push, so it cannot date a request posted in between; the exact-head
    // marker already binds the request to this head.
    const recent =
      headUpdatedAtIsUpperBound ||
      isCurrentSignal(comment.created_at ?? comment.createdAt, headUpdatedAt);
    if (matchesCurrentHead && recent) {
      hasCurrentRequest = true;
    } else {
      hasHistoricalSignal = true;
    }
  }

  if (hasCurrentRequest) return "requested";
  if (hasHistoricalSignal) return "stale";
  return "missing";
}
