function gateReady(gate) {
  return gate?.required === false || Boolean(gate?.ready ?? true);
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
  const feedbackSurfacesReady =
    unresolvedReviewThreads.length === 0 &&
    unrepliedRootReviewComments.length === 0 &&
    topLevelBotComments.length === 0;
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
    topLevelBotComments,
    counts: {
      requiredFeedbackBlockers: feedbackBlockers.length,
      unresolvedReviewThreads: unresolvedReviewThreads.length,
      unrepliedRootReviewComments: unrepliedRootReviewComments.length,
      topLevelBotComments: topLevelBotComments.length,
    },
  };
}
