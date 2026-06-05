export function summarizeFeedbackState(readyState) {
  const gates = readyState.gates ?? {};
  const requiredBlockers = readyState.required?.blockers ?? [];
  const feedbackBlockers = requiredBlockers.filter((blocker) =>
    ["review-thread", "review-comment", "gate"].includes(blocker.kind),
  );
  const unresolvedReviewThreads = readyState.unresolvedReviewThreads ?? [];
  const unrepliedRootReviewComments =
    readyState.unrepliedRootReviewComments ?? [];
  const topLevelBotComments = readyState.topLevelBotComments ?? [];
  const feedbackSurfacesReady =
    unresolvedReviewThreads.length === 0 &&
    unrepliedRootReviewComments.length === 0 &&
    topLevelBotComments.length === 0;
  const ready =
    feedbackBlockers.length === 0 &&
    feedbackSurfacesReady &&
    Boolean(gates.reviewThreads?.ready ?? true) &&
    Boolean(gates.reviewCommentReplies?.ready ?? true) &&
    Boolean(gates.codexDescriptionApproval?.ready ?? true);

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
    topLevelBotComments,
    counts: {
      requiredFeedbackBlockers: feedbackBlockers.length,
      unresolvedReviewThreads: unresolvedReviewThreads.length,
      unrepliedRootReviewComments: unrepliedRootReviewComments.length,
      topLevelBotComments: topLevelBotComments.length,
    },
  };
}
