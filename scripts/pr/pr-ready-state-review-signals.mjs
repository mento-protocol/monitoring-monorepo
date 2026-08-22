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

export function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isAtOrAfter(timestamp, lowerBound) {
  const parsed = parseTimestamp(timestamp);
  return parsed !== null && lowerBound !== null && parsed >= lowerBound;
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
  if (!/(^|\s)@coderabbitai\s+review\b/i.test(text)) return null;
  return text.match(CODERABBIT_FINAL_HEAD_REQUEST_MARKER)?.[1] ?? null;
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

  for (const comment of issueComments) {
    if (!isTrustedCodeRabbitReviewRequestComment(comment)) continue;
    const requestedHead = codeRabbitFinalHeadReviewRequestHead(comment.body);
    if (!requestedHead) continue;
    const matchesCurrentHead =
      currentHead && requestedHead.toLowerCase() === currentHead;

    if (
      matchesCurrentHead &&
      isCurrentSignal(comment.created_at ?? comment.createdAt, headUpdatedAt)
    ) {
      hasCurrentRequest = true;
    } else {
      hasHistoricalSignal = true;
    }
  }

  if (hasCurrentRequest) return "requested";
  if (hasHistoricalSignal) return "stale";
  return "missing";
}
