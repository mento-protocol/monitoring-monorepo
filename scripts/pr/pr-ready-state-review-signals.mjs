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
const CODERABBIT_COMMAND_REPLY_MARKER =
  /<!--\s*CodeRabbit review command invocation:[^\r\n>]*-->/i;
const CODERABBIT_COMMAND_NOT_COMPLETED =
  /<summary>[^<\r\n]*Action not completed[^<\r\n]*<\/summary>/i;
const CODERABBIT_RATE_LIMIT_REFUSAL = /^\s*Review rate limited\.?\s*$/m;

export function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? null : timestamp;
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
  if (!CODERABBIT_REVIEW_REQUEST_COMMAND.test(text)) return null;
  return text.match(CODERABBIT_FINAL_HEAD_REQUEST_MARKER)?.[1] ?? null;
}

/** Trusted request comments, marked or bare, counted against the budget. */
export function countTrustedCodeRabbitReviewRequests(issueComments = []) {
  return issueComments.filter(
    (comment) =>
      isTrustedCodeRabbitReviewRequestComment(comment) &&
      CODERABBIT_REVIEW_REQUEST_COMMAND.test(String(comment?.body ?? "")),
  ).length;
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

function isCodeRabbitAuthored(comment) {
  const author = comment.user?.login ?? comment.author?.login ?? null;
  return CODERABBIT_AUTHORS.has(String(author ?? "").toLowerCase());
}

/**
 * The epoch-ms time CodeRabbit refused the current head's own review request
 * over the rate limit, or `null` when no such refusal stands.
 *
 * CodeRabbit answers each `@coderabbitai review` comment with one
 * auto-generated reply carrying its invocation marker. The reply names no
 * request id, so it binds to the first such reply after the newest trusted
 * head-marked request. Later replies belong to other commands and leave the
 * outcome alone; only another request supersedes it — which is how the
 * accepted retry clears a refusal. Only a CodeRabbit-authored reply and a
 * trusted head-marked request participate, so refusal text an untrusted author
 * posts cannot flip the state.
 */
export function codeRabbitRateLimitRefusalTime({
  issueComments = [],
  currentHeadOid = null,
} = {}) {
  const currentHead = String(currentHeadOid ?? "").toLowerCase();
  if (!currentHead) return null;

  const ordered = issueComments
    .map((comment) => ({
      comment,
      at: parseTimestamp(comment.created_at ?? comment.createdAt),
    }))
    .filter((entry) => entry.at !== null)
    .sort((left, right) => left.at - right.at);

  let awaitingReply = false;
  let refusedAt = null;
  for (const { comment, at } of ordered) {
    const body = String(comment.body ?? "");
    if (
      isTrustedCodeRabbitReviewRequestComment(comment) &&
      CODERABBIT_REVIEW_REQUEST_COMMAND.test(body)
    ) {
      awaitingReply =
        codeRabbitFinalHeadReviewRequestHead(body)?.toLowerCase() ===
        currentHead;
      refusedAt = null;
      continue;
    }
    if (!awaitingReply || !isCodeRabbitAuthored(comment)) continue;
    if (!CODERABBIT_COMMAND_REPLY_MARKER.test(body)) continue;
    // This reply answered the request. A later one answers another command, so
    // it must not clear a standing refusal and strand the retry.
    awaitingReply = false;
    refusedAt =
      CODERABBIT_COMMAND_NOT_COMPLETED.test(body) &&
      CODERABBIT_RATE_LIMIT_REFUSAL.test(body)
        ? at
        : null;
  }
  return refusedAt;
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
  if (!isCodeRabbitAuthored(comment)) return null;
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
  pathFilterSkip = null,
  refusedAt = null,
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
    if (!isCodeRabbitAuthored(comment)) continue;

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

    // The marker names the full head SHA, so the request cannot predate the
    // head it binds to; no timestamp test is needed.
    if (matchesCurrentHead) {
      hasCurrentRequest = true;
    } else {
      hasHistoricalSignal = true;
    }
  }

  // A refused request is spent without producing a review, so it must not read
  // as a review on the way.
  if (hasCurrentRequest) return refusedAt === null ? "requested" : "refused";
  if (hasHistoricalSignal) return "stale";
  return "missing";
}
