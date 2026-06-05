function gateReady(gate) {
  return gate?.required === false || Boolean(gate?.ready ?? true);
}

function commentTimestamp(comment) {
  return Date.parse(comment.updatedAt ?? comment.createdAt ?? "");
}

function isCurrentHeadComment(comment, headUpdatedAt) {
  const headTimestamp = Date.parse(headUpdatedAt ?? "");
  if (!Number.isFinite(headTimestamp)) return true;
  const timestamp = commentTimestamp(comment);
  return Number.isFinite(timestamp) && timestamp >= headTimestamp;
}

function isReviewBotComment(comment) {
  return [
    "chatgpt-codex-connector",
    "chatgpt-codex-connector[bot]",
    "claude",
    "claude[bot]",
    "cursor",
    "cursor[bot]",
  ].includes(String(comment.author ?? "").toLowerCase());
}

function isActionableReviewBotComment(comment) {
  if (!isReviewBotComment(comment)) return false;
  return /BUGBOT_BUG_ID|changes requested|finding|findings|fail|error|P[0-3]|severity/i.test(
    String(comment.body ?? ""),
  );
}

export function summarizeFeedbackState(readyState) {
  const gates = readyState.gates ?? {};
  const requiredBlockers = readyState.required?.blockers ?? [];
  const feedbackBlockers = requiredBlockers.filter((blocker) => {
    if (["review-thread", "review-comment"].includes(blocker.kind)) {
      return true;
    }
    if (blocker.kind === "review") {
      return ["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(blocker.state);
    }
    return (
      blocker.kind === "gate" &&
      blocker.name === "Codex PR-description approval"
    );
  });
  const unresolvedReviewThreads = readyState.unresolvedReviewThreads ?? [];
  const unrepliedRootReviewComments =
    readyState.unrepliedRootReviewComments ?? [];
  const topLevelBotComments = readyState.topLevelBotComments ?? [];
  const blockingTopLevelBotComments = topLevelBotComments.filter(
    (comment) =>
      isCurrentHeadComment(comment, readyState.pr?.headUpdatedAt) &&
      isActionableReviewBotComment(comment),
  );
  const feedbackSurfacesReady =
    unresolvedReviewThreads.length === 0 &&
    unrepliedRootReviewComments.length === 0 &&
    blockingTopLevelBotComments.length === 0;
  const ready =
    feedbackBlockers.length === 0 &&
    feedbackSurfacesReady &&
    gateReady(gates.reviewThreads) &&
    gateReady(gates.reviewCommentReplies) &&
    gateReady(gates.codexDescriptionApproval);

  return {
    ready,
    pr: readyState.pr,
    summary: ready
      ? "Feedback gates are clear."
      : "Feedback surfaces need attention.",
    gates: {
      codexDescriptionApproval: gates.codexDescriptionApproval ?? null,
      codexReviewSignal: gates.codexReviewSignal ?? null,
      reviewCommentReplies: gates.reviewCommentReplies ?? null,
      reviewThreads: gates.reviewThreads ?? null,
    },
    requiredFeedbackBlockers: feedbackBlockers,
    unresolvedReviewThreads,
    unrepliedRootReviewComments,
    blockingTopLevelBotComments,
    topLevelBotComments,
    counts: {
      requiredFeedbackBlockers: feedbackBlockers.length,
      unresolvedReviewThreads: unresolvedReviewThreads.length,
      unrepliedRootReviewComments: unrepliedRootReviewComments.length,
      blockingTopLevelBotComments: blockingTopLevelBotComments.length,
      topLevelBotComments: topLevelBotComments.length,
    },
  };
}
