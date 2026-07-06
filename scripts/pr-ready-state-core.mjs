export const BOT_APPROVER = "chatgpt-codex-connector[bot]";
const BOT_APPROVER_LOGIN = "chatgpt-codex-connector";
const OPTIONAL_CHECK_NAMES = new Set([
  "Core Web Vitals + accessibility (ui-dashboard)",
  "Cursor Bugbot",
  "GraphQL schema diff",
  "jscpd",
]);

const PASS_VALUES = new Set(["SUCCESS", "PASSED", "PASS"]);
const FAIL_VALUES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAIL",
  "FAILED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const PENDING_VALUES = new Set([
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const SKIPPED_VALUES = new Set(["NEUTRAL", "SKIPPED"]);
const HUMAN_OVERRIDE_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
const READINESS_OVERRIDE_COMMAND = "/pr-ready-override";
const CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE = "codex-description-approval";

function normalizeStatusValue(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

export function checkDisplayName(check) {
  return (
    check.name ??
    check.context ??
    check.workflowName ??
    check.app?.name ??
    check.__typename ??
    "unknown check"
  );
}

function isOptionalCheckName(name) {
  return OPTIONAL_CHECK_NAMES.has(name);
}

export function classifyCheck(check) {
  const values = [
    check.conclusion,
    check.state,
    check.status,
    check.rollupStatus,
  ].map(normalizeStatusValue);

  if (values.some((value) => FAIL_VALUES.has(value))) return "fail";
  if (values.some((value) => PENDING_VALUES.has(value))) return "pending";
  if (values.some((value) => SKIPPED_VALUES.has(value))) return "skipped";
  if (values.some((value) => PASS_VALUES.has(value))) return "pass";

  return "pending";
}

function checkRunOrderTimestampMs(check) {
  // Use startedAt so delayed cancellation completion does not make a stale
  // run appear newer than the passing run that superseded it.
  const timestamp = check.startedAt ?? check.completedAt ?? null;
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function checkIdentity(check) {
  const appId =
    check.appId ?? check.app_id ?? check.app?.id ?? check.app?.databaseId ?? "";
  return [
    checkDisplayName(check),
    check.workflowName ?? check.workflow_name ?? "",
    appId,
  ].join("\0");
}

function suppressSupersededCancelledChecks(statusCheckRollup = []) {
  const latestPassingTimeByIdentity = new Map();

  for (const check of statusCheckRollup) {
    if (classifyCheck(check) !== "pass") continue;
    const timestampMs = checkRunOrderTimestampMs(check);
    if (timestampMs === null) continue;
    const identity = checkIdentity(check);
    const previous = latestPassingTimeByIdentity.get(identity) ?? -Infinity;
    if (timestampMs > previous) {
      latestPassingTimeByIdentity.set(identity, timestampMs);
    }
  }

  return statusCheckRollup.filter((check) => {
    if (normalizeStatusValue(check.conclusion) !== "CANCELLED") return true;
    const timestampMs = checkRunOrderTimestampMs(check);
    if (timestampMs === null) return true;
    const newerPassingTime = latestPassingTimeByIdentity.get(
      checkIdentity(check),
    );
    return newerPassingTime === undefined || newerPassingTime <= timestampMs;
  });
}

export function groupStatusChecks(statusCheckRollup = []) {
  const grouped = {
    pass: [],
    fail: [],
    pending: [],
    skipped: [],
  };

  for (const check of suppressSupersededCancelledChecks(statusCheckRollup)) {
    const group = classifyCheck(check);
    grouped[group].push({
      name: checkDisplayName(check),
      status: check.status ?? check.state ?? null,
      conclusion: check.conclusion ?? null,
      detailsUrl: check.detailsUrl ?? check.targetUrl ?? null,
    });
  }

  for (const checks of Object.values(grouped)) {
    checks.sort((a, b) => a.name.localeCompare(b.name));
  }

  return grouped;
}

function requiredContextName(context) {
  return typeof context === "string" ? context : context.context;
}

function requiredContextIntegrationId(context) {
  const value =
    typeof context === "string"
      ? null
      : (context.integrationId ?? context.integration_id ?? null);
  return value === null || value === undefined ? null : Number(value);
}

function requiredContextIdentity(context) {
  return `${requiredContextName(context)}\0${requiredContextIntegrationId(context) ?? ""}`;
}

function checkAppId(check) {
  const value =
    check.appId ??
    check.app_id ??
    check.app?.id ??
    check.app?.databaseId ??
    null;
  return value === null || value === undefined ? null : Number(value);
}

function checkMatchesRequiredContext(check, context) {
  if (checkDisplayName(check) !== requiredContextName(context)) return false;

  const requiredIntegrationId = requiredContextIntegrationId(context);
  if (requiredIntegrationId === null) return true;

  const appId = checkAppId(check);
  return appId !== null && appId === requiredIntegrationId;
}

function checkToItem(check, { required }) {
  const state = classifyCheck(check);
  return {
    kind: "check",
    name: checkDisplayName(check),
    state,
    required,
    url: check.detailsUrl ?? check.targetUrl ?? null,
  };
}

export function splitRequiredAndOptionalChecks(
  statusCheckRollup = [],
  requiredStatusContexts = [],
  { requiredStatusContextsAvailable = requiredStatusContexts.length > 0 } = {},
) {
  const required = [];
  const optional = [];
  const seenRequiredContexts = new Set();

  for (const check of suppressSupersededCancelledChecks(statusCheckRollup)) {
    const name = checkDisplayName(check);
    const matchedRequiredContext = requiredStatusContexts.find((context) =>
      checkMatchesRequiredContext(check, context),
    );
    const isRequired = requiredStatusContextsAvailable
      ? matchedRequiredContext !== undefined
      : !isOptionalCheckName(name);
    if (isRequired) {
      seenRequiredContexts.add(
        matchedRequiredContext === undefined
          ? name
          : requiredContextIdentity(matchedRequiredContext),
      );
    }
    const item = checkToItem(check, { required: isRequired });
    if (isRequired) {
      required.push(item);
    } else {
      optional.push(item);
    }
  }

  for (const context of requiredStatusContexts) {
    const name = requiredContextName(context);
    if (!seenRequiredContexts.has(requiredContextIdentity(context))) {
      required.push({
        kind: "check",
        name,
        state: "pending",
        required: true,
        url: null,
      });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  required.sort(byName);
  optional.sort(byName);

  return { required, optional };
}

export function findUnresolvedReviewThreads(reviewThreads = []) {
  return summarizeReviewThreads(reviewThreads)
    .filter((thread) => thread.isResolved === false)
    .map(({ isResolved: _isResolved, ...thread }) => thread);
}

export function summarizeReviewThreads(reviewThreads = []) {
  return reviewThreads.map((thread) => {
    const firstComment = thread.comments?.nodes?.[0] ?? thread.comments?.[0];
    return {
      id: thread.id,
      path: thread.path ?? null,
      line: thread.line ?? thread.startLine ?? null,
      isOutdated: Boolean(thread.isOutdated),
      isResolved: Boolean(thread.isResolved),
      author: firstComment?.author?.login ?? firstComment?.user?.login ?? null,
      url: firstComment?.url ?? null,
      body: firstComment?.body ?? "",
    };
  });
}

export function findUnrepliedRootReviewComments(
  reviewComments = [],
  ignoredAuthors = [],
  allowedReplyAuthors = null,
) {
  const repliedRootIds = repliedRootReviewCommentIds(
    reviewComments,
    allowedReplyAuthors,
  );
  const ignoredAuthorSet = new Set(ignoredAuthors.filter(Boolean));

  return reviewComments
    .filter((comment) => commentIsRootReviewComment(comment))
    .filter((comment) => !ignoredAuthorSet.has(comment.user?.login))
    .filter((comment) => !repliedRootIds.has(comment.id))
    .map(reviewCommentSummary);
}

function commentIsRootReviewComment(comment) {
  return (
    comment.in_reply_to_id === undefined || comment.in_reply_to_id === null
  );
}

function repliedRootReviewCommentIds(
  reviewComments = [],
  allowedReplyAuthors = null,
) {
  const allowedReplyAuthorSet =
    allowedReplyAuthors === null
      ? null
      : new Set(allowedReplyAuthors.filter(Boolean));

  return new Set(
    reviewComments
      .filter((comment) => {
        const rootId = comment.in_reply_to_id;
        if (rootId === undefined || rootId === null) return false;
        return (
          allowedReplyAuthorSet === null ||
          allowedReplyAuthorSet.has(comment.user?.login)
        );
      })
      .map((comment) => comment.in_reply_to_id),
  );
}

function reviewCommentSummary(comment, { replied = undefined } = {}) {
  const summary = {
    id: comment.id,
    path: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    author: comment.user?.login ?? null,
    url: comment.html_url ?? comment.url ?? null,
    body: comment.body ?? "",
  };
  if (replied !== undefined) summary.replied = replied;
  return summary;
}

function summarizeRootReviewComments(
  reviewComments = [],
  ignoredAuthors = [],
  allowedReplyAuthors = null,
) {
  const repliedRootIds = repliedRootReviewCommentIds(
    reviewComments,
    allowedReplyAuthors,
  );
  const ignoredAuthorSet = new Set(ignoredAuthors.filter(Boolean));

  return reviewComments
    .filter(
      (comment) =>
        comment.in_reply_to_id === undefined || comment.in_reply_to_id === null,
    )
    .filter((comment) => !ignoredAuthorSet.has(comment.user?.login))
    .map((comment) =>
      reviewCommentSummary(comment, {
        replied: repliedRootIds.has(comment.id),
      }),
    );
}

export function findTopLevelBotComments(issueComments = []) {
  return issueComments
    .filter((comment) => {
      const user = comment.user ?? {};
      const login = user.login ?? "";
      return user.type === "Bot" || login.endsWith("[bot]");
    })
    .map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? null,
      url: comment.html_url ?? comment.url ?? null,
      createdAt: comment.created_at ?? null,
      updatedAt: comment.updated_at ?? null,
      body: comment.body ?? "",
    }));
}

export function findTopLevelBotReviewComments(reviews = []) {
  return reviews
    .filter((review) => {
      const author = review.author ?? {};
      const login = author.login ?? "";
      return (
        (author.type === "Bot" || login.endsWith("[bot]")) &&
        String(review.body ?? "").trim() !== ""
      );
    })
    .map((review) => ({
      id: review.id ?? null,
      author: review.author?.login ?? null,
      url: review.url ?? null,
      createdAt: review.submittedAt ?? null,
      updatedAt: null,
      commitOid: review.commit?.oid ?? null,
      state: review.state ?? null,
      body: review.body ?? "",
    }));
}

export function isCodexReviewRequestBody(body) {
  return /(^|\s)@codex\s+review\b/i.test(String(body ?? ""));
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

function isAtOrAfter(timestamp, lowerBound) {
  const parsed = parseTimestamp(timestamp);
  return parsed !== null && lowerBound !== null && parsed >= lowerBound;
}

function isCurrentSignal(timestamp, lowerBound) {
  if (lowerBound === null) return true;
  return isAtOrAfter(timestamp, lowerBound);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? null : timestamp;
}

function issueCommentAuthorAssociation(comment) {
  return String(
    comment.author_association ?? comment.authorAssociation ?? "",
  ).toUpperCase();
}

function isHumanOverrideAuthor(comment) {
  const login = comment.user?.login ?? comment.author?.login ?? "";
  const type = comment.user?.type ?? comment.author?.type ?? "";
  return (
    !String(login).endsWith("[bot]") &&
    type !== "Bot" &&
    HUMAN_OVERRIDE_ASSOCIATIONS.has(issueCommentAuthorAssociation(comment))
  );
}

function extractOverrideValue(body, key) {
  const source = String(body ?? "");
  const pattern = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "i");
  return source.match(pattern)?.[1] ?? null;
}

function extractOverrideReason(body) {
  const match = String(body ?? "").match(/(?:^|\s)reason=(.+)$/im);
  return match?.[1]?.trim() ?? "";
}

export function parseReadinessOverrideComment(comment, currentHeadOid = null) {
  const body = String(comment.body ?? "");
  if (
    !body
      .trimStart()
      .match(new RegExp(`^${READINESS_OVERRIDE_COMMAND}\\b`, "i"))
  ) {
    return null;
  }

  const gate = extractOverrideValue(body, "gate")?.toLowerCase() ?? null;
  const head = extractOverrideValue(body, "head");
  const reason = extractOverrideReason(body);
  const author = comment.user?.login ?? comment.author?.login ?? null;
  const createdAt = comment.created_at ?? comment.createdAt ?? null;
  const base = {
    gate,
    head,
    reason,
    author,
    authorAssociation:
      comment.author_association ?? comment.authorAssociation ?? null,
    url: comment.html_url ?? comment.url ?? null,
    createdAt,
    state: "ignored",
  };

  if (!isHumanOverrideAuthor(comment)) {
    return { ...base, reasonIgnored: "author_not_allowed" };
  }
  if (gate !== CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE) {
    return { ...base, reasonIgnored: "unsupported_gate" };
  }
  if (!head || !currentHeadOid || head !== currentHeadOid) {
    return { ...base, reasonIgnored: "head_mismatch" };
  }
  if (!reason) {
    return { ...base, reasonIgnored: "missing_reason" };
  }

  return {
    ...base,
    state: "active",
  };
}

function findActiveReadinessOverrides(
  issueComments = [],
  currentHeadOid = null,
) {
  return issueComments
    .map((comment) => parseReadinessOverrideComment(comment, currentHeadOid))
    .filter((override) => override?.state === "active")
    .sort((a, b) => {
      const aTime = parseTimestamp(a.createdAt) ?? 0;
      const bTime = parseTimestamp(b.createdAt) ?? 0;
      return bTime - aTime;
    });
}

function currentHeadUpdatedAt(pr) {
  return parseTimestamp(pr.headUpdatedAt ?? pr.headPushedAt);
}

function summaryPr(pr, headUpdatedAt = currentHeadUpdatedAt(pr)) {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state ?? null,
    isDraft: Boolean(pr.isDraft),
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    headUpdatedAt:
      headUpdatedAt === null ? null : new Date(headUpdatedAt).toISOString(),
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.closedAt ?? null,
  };
}

function emptyStatusChecks() {
  return {
    pass: [],
    fail: [],
    pending: [],
    skipped: [],
  };
}

function terminalGates({ merged }) {
  return {
    codexDescriptionApproval: {
      ready: true,
      required: merged,
      state: merged ? "present" : "not_applicable",
    },
    codexReviewSignal: {
      ready: true,
      required: false,
      state: merged ? "approved" : "not_applicable",
      fallbackAction: "wait",
    },
    reviewCommentReplies: {
      ready: true,
      required: merged,
      unrepliedCount: 0,
    },
    reviewThreads: {
      ready: true,
      required: merged,
      unresolvedCount: 0,
    },
  };
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

export function summarizeTerminalReadyState(pr) {
  const state = normalizeStatusValue(pr.state);
  const merged = state === "MERGED";
  const requiredBlockers = merged
    ? []
    : [
        {
          kind: "state",
          name: "Pull request is closed",
          state: pr.state ?? "CLOSED",
          required: true,
          url: pr.url,
        },
      ];

  return {
    ready: merged,
    required: {
      ready: merged,
      blockers: requiredBlockers,
    },
    optional: {
      ready: true,
      items: [],
    },
    gates: terminalGates({ merged }),
    summary: merged
      ? "Pull request is already merged."
      : "Pull request is closed without merging.",
    pr: summaryPr(pr),
    statusChecks: emptyStatusChecks(),
    requiredStatusContexts: [],
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
    codexApprovalReaction: merged,
    codexReviewSignal: merged ? "approved" : "missing",
  };
}

export function summarizeReadyState({
  pr,
  issueComments = [],
  reactions = [],
  reviewComments = [],
  reviewThreads = [],
  requiredStatusContexts = [],
  requiredStatusContextsError = null,
  requiredStatusContextsAvailable = requiredStatusContexts.length > 0,
  includeFeedbackDetails = false,
}) {
  const statusChecks = groupStatusChecks(pr.statusCheckRollup ?? []);
  const splitChecks = splitRequiredAndOptionalChecks(
    pr.statusCheckRollup ?? [],
    requiredStatusContexts,
    { requiredStatusContextsAvailable },
  );
  const reviewThreadSummaries = summarizeReviewThreads(reviewThreads);
  const unresolvedReviewThreads = reviewThreadSummaries
    .filter((thread) => thread.isResolved === false)
    .map(({ isResolved: _isResolved, ...thread }) => thread);
  const rootReviewComments = summarizeRootReviewComments(
    reviewComments,
    [pr.author?.login],
    [pr.author?.login, BOT_APPROVER],
  );
  const unrepliedRootReviewComments = rootReviewComments.filter(
    (comment) => comment.replied === false,
  );
  const topLevelBotComments = [
    ...findTopLevelBotComments(issueComments),
    ...findTopLevelBotReviewComments(pr.reviews ?? []),
  ];
  const headUpdatedAt = currentHeadUpdatedAt(pr);
  const codexApprovalReaction = hasCodexApprovalReaction(
    reactions,
    headUpdatedAt,
  );
  const codexInFlightReaction = hasCodexInFlightReaction(
    reactions,
    headUpdatedAt,
  );
  const currentHeadOid = pr.headRefOid ?? pr.headOid ?? null;
  const codexReviewSignal = classifyCodexReviewSignal({
    issueComments,
    reviews: pr.reviews ?? [],
    headUpdatedAt,
    currentHeadOid,
    codexApprovalReaction,
    codexInFlightReaction,
  });
  const activeReadinessOverrides = findActiveReadinessOverrides(
    issueComments,
    currentHeadOid,
  );
  // Keep the gate/head check at the use site so later override types cannot
  // satisfy this gate merely by appearing in the active override list.
  const codexDescriptionApprovalOverride = activeReadinessOverrides.find(
    (override) =>
      override.gate === CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE &&
      override.head === currentHeadOid,
  );
  const codexDescriptionApprovalReady =
    codexApprovalReaction || Boolean(codexDescriptionApprovalOverride);

  const mergeable = normalizeStatusValue(pr.mergeable) === "MERGEABLE";
  const reviewDecision = normalizeStatusValue(pr.reviewDecision);
  const requiredCheckBlockers = splitChecks.required.filter((check) =>
    ["fail", "pending"].includes(check.state),
  );
  const optionalItems = splitChecks.optional.filter((check) =>
    ["fail", "pending"].includes(check.state),
  );
  const requiredBlockers = [];

  if (pr.isDraft) {
    requiredBlockers.push({
      kind: "draft",
      name: "Pull request is draft",
      state: "draft",
      required: true,
      url: pr.url,
    });
  }

  if (!mergeable) {
    requiredBlockers.push({
      kind: "mergeability",
      name: "Pull request is not mergeable",
      state: pr.mergeable ?? "UNKNOWN",
      required: true,
      url: pr.url,
    });
  }

  if (reviewDecision === "CHANGES_REQUESTED") {
    requiredBlockers.push({
      kind: "review",
      name: "Changes requested",
      state: pr.reviewDecision,
      required: true,
      url: pr.url,
    });
  }

  if (reviewDecision === "REVIEW_REQUIRED") {
    requiredBlockers.push({
      kind: "review",
      name: "Review required",
      state: pr.reviewDecision,
      required: true,
      url: pr.url,
    });
  }

  if (requiredStatusContextsError !== null) {
    requiredBlockers.push({
      kind: "branch-protection",
      name: "Required status contexts unavailable",
      state: requiredStatusContextsError,
      required: true,
      url: pr.url,
    });
  }

  requiredBlockers.push(...requiredCheckBlockers);

  for (const thread of unresolvedReviewThreads) {
    requiredBlockers.push({
      kind: "review-thread",
      name: thread.path ?? thread.id ?? "unresolved review thread",
      state: thread.isOutdated ? "unresolved-outdated" : "unresolved",
      required: true,
      url: thread.url,
    });
  }

  for (const comment of unrepliedRootReviewComments) {
    requiredBlockers.push({
      kind: "review-comment",
      name: `unreplied root comment ${comment.id}`,
      state: "unreplied",
      required: true,
      url: comment.url,
    });
  }

  const gates = {
    codexDescriptionApproval: {
      ready: codexDescriptionApprovalReady,
      required: true,
      state: codexApprovalReaction
        ? "present"
        : codexDescriptionApprovalOverride
          ? "overridden"
          : "missing",
      ...(codexDescriptionApprovalOverride
        ? { override: codexDescriptionApprovalOverride }
        : {}),
    },
    codexReviewSignal: {
      ready: ["approved", "in_flight"].includes(codexReviewSignal),
      required: false,
      state: codexReviewSignal,
      fallbackAction:
        codexReviewSignal === "missing" || codexReviewSignal === "stale"
          ? "request_review_once_after_grace"
          : "wait",
    },
    reviewCommentReplies: {
      ready: unrepliedRootReviewComments.length === 0,
      required: true,
      unrepliedCount: unrepliedRootReviewComments.length,
    },
    reviewThreads: {
      ready: unresolvedReviewThreads.length === 0,
      required: true,
      unresolvedCount: unresolvedReviewThreads.length,
    },
  };

  if (!codexDescriptionApprovalReady) {
    requiredBlockers.push({
      kind: "gate",
      name: "Codex PR-description approval",
      state: "missing",
      required: true,
      url: pr.url,
    });
  }

  const required = {
    ready: requiredBlockers.length === 0,
    blockers: requiredBlockers,
  };
  const optional = {
    ready: optionalItems.length === 0,
    items: optionalItems,
  };
  const ready = required.ready;
  const summaryText = ready
    ? optional.items.length > 0
      ? `Required gates are clear; ${optional.items.length} optional signal(s) still need attention.`
      : "Required gates are clear."
    : `${required.blockers.length} required blocker(s) remain.`;

  const readyStateSummary = {
    ready,
    required,
    optional,
    gates,
    summary: summaryText,
    pr: summaryPr(pr, headUpdatedAt),
    statusChecks,
    requiredStatusContexts,
    unresolvedReviewThreads,
    unrepliedRootReviewComments,
    topLevelBotComments,
    readinessOverrides: activeReadinessOverrides,
    codexApprovalReaction,
    codexReviewSignal,
  };

  if (includeFeedbackDetails) {
    readyStateSummary.reviewThreads = reviewThreadSummaries;
    readyStateSummary.rootReviewComments = rootReviewComments;
  }

  return readyStateSummary;
}
