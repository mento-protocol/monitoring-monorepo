import {
  authorLogin,
  isClaudeEvidence,
  isClaudeSummary,
  isCodexApprovalComment,
  isCodexBotLogin,
  isCodexUsageLimit,
  isFindingLikeText,
  isReviewBotEvidence,
} from "./review-process-metrics-core.mjs";

function timestamp(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function hoursBetween(start, end) {
  const startTime = timestamp(start);
  const endTime = timestamp(end);
  if (startTime === null || endTime === null) return null;
  return Math.round(((endTime - startTime) / 3_600_000) * 100) / 100;
}

function isLegacyReviewRequest(value) {
  return /@(codex|claude)\s+review\b/i.test(String(value ?? ""));
}

function uniqueRootReviewComments(reviewComments) {
  return reviewComments.filter((comment) => comment.in_reply_to_id == null);
}

function reviewCommentReplyCount(reviewComments) {
  return reviewComments.filter((comment) => comment.in_reply_to_id != null)
    .length;
}

function rootReviewCommentsWithoutReplies(reviewComments) {
  const repliedRootIds = new Set(
    reviewComments
      .map((comment) => comment.in_reply_to_id)
      .filter((id) => id !== null && id !== undefined),
  );
  return uniqueRootReviewComments(reviewComments).filter(
    (comment) => !repliedRootIds.has(comment.id),
  );
}

function earliestReviewTimestamp({
  prUrl,
  issueComments = [],
  reviewComments = [],
  reviews = [],
}) {
  const candidates = [];
  for (const comment of issueComments) {
    if (
      isReviewBotEvidence(comment, prUrl) ||
      isLegacyReviewRequest(comment.body)
    ) {
      candidates.push(timestamp(comment.createdAt ?? comment.created_at));
    }
  }
  for (const comment of reviewComments) {
    candidates.push(timestamp(comment.created_at ?? comment.createdAt));
  }
  for (const review of reviews) {
    candidates.push(timestamp(review.submittedAt ?? review.submitted_at));
  }
  const finite = candidates.filter((time) => time !== null);
  return finite.length === 0 ? null : Math.min(...finite);
}

function countCommitsAfter(commits, cutoff) {
  if (cutoff === null) return null;
  return commits.filter((commit) => {
    const committedAt = timestamp(
      commit.committedDate ?? commit.commit?.committer?.date,
    );
    return committedAt !== null && committedAt > cutoff;
  }).length;
}

export function selectMergedBefore(prs, beforeMergedAt, limit = 20) {
  const cutoff = timestamp(beforeMergedAt);
  if (cutoff === null) throw new Error("beforeMergedAt must be a timestamp");
  return [...prs]
    .filter((pr) => {
      const mergedAt = timestamp(pr.mergedAt);
      return mergedAt !== null && mergedAt < cutoff;
    })
    .sort((a, b) => timestamp(b.mergedAt) - timestamp(a.mergedAt))
    .slice(0, limit);
}

export function selectMergedAfter(prs, afterMergedAt, limit = 20) {
  const cutoff = timestamp(afterMergedAt);
  if (cutoff === null) throw new Error("afterMergedAt must be a timestamp");
  return [...prs]
    .filter((pr) => {
      const mergedAt = timestamp(pr.mergedAt);
      return mergedAt !== null && mergedAt > cutoff;
    })
    .sort((a, b) => timestamp(a.mergedAt) - timestamp(b.mergedAt))
    .slice(0, limit);
}

export function selectMergedInUtcWindow(prs, since, until) {
  const sinceTime = timestamp(since);
  const untilTime = timestamp(until);
  if (sinceTime === null || untilTime === null || sinceTime >= untilTime) {
    throw new Error("UTC cohort requires since before until");
  }
  return [...prs]
    .filter((pr) => {
      const mergedAt = timestamp(pr.mergedAt);
      return mergedAt !== null && mergedAt >= sinceTime && mergedAt < untilTime;
    })
    .sort((a, b) => timestamp(a.mergedAt) - timestamp(b.mergedAt));
}

export function assertCompleteCohort(cohort, { direction, limit, boundary }) {
  if (cohort.length >= limit) return cohort;
  throw new Error(
    `only found ${cohort.length} merged PR(s) ${direction} PR #${boundary.number}; requested ${limit}`,
  );
}

export function summarizePullRequestMetrics({
  pr,
  reviewComments = [],
  collectedAt = new Date().toISOString(),
}) {
  const issueComments = pr.comments ?? [];
  const reviews = pr.reviews ?? [];
  const commits = pr.commits ?? [];
  const prUrl = pr.url ?? null;
  const rootReviewComments = uniqueRootReviewComments(reviewComments);
  const firstReviewAt = earliestReviewTimestamp({
    prUrl,
    issueComments,
    reviewComments,
    reviews,
  });
  const reviewBotTopLevel = issueComments.filter((comment) =>
    isReviewBotEvidence(comment, prUrl),
  );
  const reviewBotInlineRoots = rootReviewComments.filter((comment) =>
    isReviewBotEvidence(comment, prUrl),
  );
  const humanReviewRequests = issueComments.filter(
    (comment) =>
      !isReviewBotEvidence(comment, prUrl) &&
      isLegacyReviewRequest(comment.body),
  );
  const findingLikeTopLevel = issueComments.filter(
    (comment) =>
      isReviewBotEvidence(comment, prUrl) && isFindingLikeText(comment.body),
  );
  const findingLikeInline = rootReviewComments.filter((comment) =>
    isFindingLikeText(comment.body),
  );
  const claudeTopLevel = issueComments.filter(
    (comment) =>
      isClaudeEvidence(comment, prUrl) && isClaudeSummary(comment.body),
  );
  const codexTopLevel = issueComments.filter((comment) =>
    isCodexBotLogin(authorLogin(comment)),
  );

  return {
    number: pr.number,
    title: pr.title,
    url: prUrl,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    collectedAt,
    durationHours: hoursBetween(pr.createdAt, pr.mergedAt),
    changedFiles: pr.changedFiles ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    commits: commits.length,
    commitsAfterFirstReview: countCommitsAfter(commits, firstReviewAt),
    reviews: {
      submissions: reviews.length,
      byBots: reviews.filter((review) => isReviewBotEvidence(review, prUrl))
        .length,
      byHumans: reviews.filter((review) => !isReviewBotEvidence(review, prUrl))
        .length,
    },
    comments: {
      topLevel: issueComments.length,
      reviewInlineRoots: rootReviewComments.length,
      reviewInlineReplies: reviewCommentReplyCount(reviewComments),
      reviewInlineRootsWithoutReplies:
        rootReviewCommentsWithoutReplies(reviewComments).length,
      humanReviewRequests: humanReviewRequests.length,
    },
    botReviewSignals: {
      topLevelReviewBotComments: reviewBotTopLevel.length,
      inlineReviewBotRoots: reviewBotInlineRoots.length,
      findingLikeTopLevel: findingLikeTopLevel.length,
      findingLikeInline: findingLikeInline.length,
      candidateFindings: findingLikeTopLevel.length + findingLikeInline.length,
      codexComments: codexTopLevel.length,
      codexUsageLimitComments: issueComments.filter((comment) =>
        isCodexUsageLimit(comment.body),
      ).length,
      codexApprovalComments: issueComments.filter((comment) =>
        isCodexApprovalComment(comment.body),
      ).length,
      claudeSummaryComments: claudeTopLevel.length,
    },
  };
}

function numericValues(prs, selector) {
  return prs
    .map(selector)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function median(values) {
  if (values.length === 0) return null;
  const midpoint = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[midpoint];
  return (
    Math.round(((values[midpoint - 1] + values[midpoint]) / 2) * 100) / 100
  );
}

function sum(prs, selector) {
  return prs.reduce((total, pr) => {
    const value = selector(pr);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

export function aggregateMetrics(prs) {
  return {
    pullRequests: prs.length,
    medianDurationHours: median(numericValues(prs, (pr) => pr.durationHours)),
    medianCommitsAfterFirstReview: median(
      numericValues(prs, (pr) => pr.commitsAfterFirstReview),
    ),
    totals: {
      comments: sum(prs, (pr) => pr.comments.topLevel),
      inlineReviewRoots: sum(prs, (pr) => pr.comments.reviewInlineRoots),
      inlineReviewReplies: sum(prs, (pr) => pr.comments.reviewInlineReplies),
      inlineRootsWithoutReplies: sum(
        prs,
        (pr) => pr.comments.reviewInlineRootsWithoutReplies,
      ),
      humanReviewRequests: sum(prs, (pr) => pr.comments.humanReviewRequests),
      candidateFindings: sum(
        prs,
        (pr) => pr.botReviewSignals.candidateFindings,
      ),
      codexUsageLimitComments: sum(
        prs,
        (pr) => pr.botReviewSignals.codexUsageLimitComments,
      ),
      codexApprovalComments: sum(
        prs,
        (pr) => pr.botReviewSignals.codexApprovalComments,
      ),
      claudeSummaryComments: sum(
        prs,
        (pr) => pr.botReviewSignals.claudeSummaryComments,
      ),
    },
  };
}
