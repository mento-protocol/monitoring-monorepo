function gateReady(gate) {
  return gate?.required === false || Boolean(gate?.ready ?? true);
}

function commentTimestamp(comment) {
  return Date.parse(comment.updatedAt ?? comment.createdAt ?? "");
}

function referencedCommitShas(comment) {
  return Array.from(
    String(comment.body ?? "").matchAll(/\b[0-9a-f]{40}\b/gi),
    ([match]) => match.toLowerCase(),
  );
}

function isCurrentHeadComment(comment, pr) {
  const headSha = String(pr?.headRefOid ?? "").toLowerCase();
  const commitShas = referencedCommitShas(comment);
  if (headSha && commitShas.length > 0) {
    return commitShas.includes(headSha);
  }

  const headTimestamp = Date.parse(pr?.headUpdatedAt ?? "");
  if (!Number.isFinite(headTimestamp)) return false;
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
  const body = String(comment.body ?? "");

  if (/BUGBOT_BUG_ID/.test(body)) return true;
  if (
    /\bchanges requested\b/i.test(body) &&
    !/\bno\s+changes requested\b/i.test(body)
  ) {
    return true;
  }
  if (/(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b)/.test(body)) return true;
  if (/\*\*\s*(?:Critical|High|Medium|Low)\s+Severity\s*\*\*/i.test(body)) {
    return true;
  }
  if (
    /\b(?:error|errors|fail|fails|failed|failure|failures)\b/i.test(body) &&
    !/\b(?:no|zero|0)\s+(?:errors?|fails?|failed|failures?)\b/i.test(body)
  ) {
    return true;
  }

  return false;
}

export function summarizeFeedbackState(readyState) {
  const gates = readyState.gates ?? {};
  const requiredBlockers = readyState.required?.blockers ?? [];
  const feedbackBlockers = requiredBlockers.filter((blocker) => {
    if (["review-thread", "review-comment"].includes(blocker.kind)) {
      return true;
    }
    if (blocker.kind === "review") {
      return blocker.state === "CHANGES_REQUESTED";
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
      isCurrentHeadComment(comment, readyState.pr) &&
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
