import {
  BOT_APPROVER,
  classifyCodeRabbitReviewSignal,
  classifyCodexReviewSignal,
  countTrustedCodeRabbitReviewRequests,
  hasCodexApprovalReaction,
  hasCodexInFlightReaction,
  parseTimestamp,
} from "./pr-ready-state-review-signals.mjs";
import { summarizeCodeRabbitReviewGate } from "./pr-ready-state-closeout.mjs";
import {
  CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE,
  HUMAN_OVERRIDE_ASSOCIATIONS,
  findActiveReadinessOverrides,
  isTrustedHumanAuthor,
} from "./pr-ready-state-overrides.mjs";

export {
  BOT_APPROVER,
  classifyCodeRabbitReviewSignal,
  classifyCodexReviewSignal,
  countTrustedCodeRabbitReviewRequests,
  hasCodexApprovalReaction,
  hasCodexInFlightReaction,
  isCodeRabbitFinalHeadReviewRequestBody,
  isCodexReviewRequestBody,
} from "./pr-ready-state-review-signals.mjs";
export {
  findActiveReadinessOverrides,
  parseReadinessOverrideComment,
} from "./pr-ready-state-overrides.mjs";
import {
  checkDisplayName,
  classifyCheck,
  groupStatusChecks,
  isOptionalCheckName,
  normalizeStatusValue,
  suppressSupersededCancelledChecks,
} from "./pr-ready-state-check-state.mjs";
export {
  checkDisplayName,
  classifyCheck,
  groupStatusChecks,
} from "./pr-ready-state-check-state.mjs";

const MAX_DIAGNOSTIC_LENGTH = 200;

// Fold a multiline transport error into one bounded line so a blocker carrying
// it cannot break the single-line compact/watch stream.
function compactDiagnostic(value) {
  const collapsed = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
    : collapsed;
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
    // A single check can satisfy more than one required-context entry: an
    // unbound entry (no app) and an app-bound entry of the same name both
    // match any check reporting that name, e.g. when classic protection
    // requires a bare "ci" and a ruleset also requires "ci" from a specific
    // app. Mark every matching entry as seen, not just the first — crediting
    // only the first left the other permanently "pending" even though the
    // one emitted check already satisfies it too.
    const matchingRequiredContexts = requiredStatusContexts.filter((context) =>
      checkMatchesRequiredContext(check, context),
    );
    const isRequired = requiredStatusContextsAvailable
      ? matchingRequiredContexts.length > 0
      : !isOptionalCheckName(name);
    if (isRequired) {
      if (matchingRequiredContexts.length > 0) {
        for (const context of matchingRequiredContexts) {
          seenRequiredContexts.add(requiredContextIdentity(context));
        }
      } else {
        seenRequiredContexts.add(name);
      }
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
  allowedReplyAuthorAssociations = null,
) {
  const repliedRootIds = repliedRootReviewCommentIds(
    reviewComments,
    allowedReplyAuthors,
    allowedReplyAuthorAssociations,
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
  allowedReplyAuthorAssociations = null,
) {
  const allowedReplyAuthorSet =
    allowedReplyAuthors === null
      ? null
      : new Set(allowedReplyAuthors.filter(Boolean));
  const allowedReplyAuthorAssociationSet =
    allowedReplyAuthorAssociations === null
      ? null
      : new Set(
          [...allowedReplyAuthorAssociations]
            .filter(Boolean)
            .map((association) => normalizeStatusValue(association)),
        );
  const rootAuthorsById = new Map(
    reviewComments
      .filter(commentIsRootReviewComment)
      .map((comment) => [comment.id, comment.user?.login ?? null]),
  );

  return new Set(
    reviewComments
      .filter((comment) => {
        const rootId = comment.in_reply_to_id;
        if (rootId === undefined || rootId === null) return false;
        const replyAuthor = comment.user?.login ?? null;
        if (
          replyAuthor !== null &&
          replyAuthor === rootAuthorsById.get(rootId)
        ) {
          return false;
        }

        if (
          allowedReplyAuthorSet === null &&
          allowedReplyAuthorAssociationSet === null
        ) {
          return true;
        }

        return (
          allowedReplyAuthorSet?.has(replyAuthor) === true ||
          isTrustedHumanAuthor(comment, allowedReplyAuthorAssociationSet)
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
  allowedReplyAuthorAssociations = null,
) {
  const repliedRootIds = repliedRootReviewCommentIds(
    reviewComments,
    allowedReplyAuthors,
    allowedReplyAuthorAssociations,
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
    mergeStateStatus: pr.mergeStateStatus ?? null,
    autoMergeEnabledAt: pr.autoMergeRequest?.enabledAt ?? null,
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
    // Same shape as the live gate, counters included, so consumers see one
    // schema across the terminal transition.
    codeRabbitReviewSignal: summarizeCodeRabbitReviewGate("not_applicable"),
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
    notes: [],
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
    codeRabbitReviewSignal: "not_applicable",
    requiredStatusChecksStrict: null,
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
  // Tri-state: `true`/`false` when the fetched branch protection or ruleset
  // confirms the policy; `null` when unknown. Fails closed like every other
  // branch-protection lookup gap here: only a confirmed `false` demotes
  // BEHIND to a note (operator decision 2026-09-15, ADR 0103).
  requiredStatusChecksStrict = null,
  // The base branch head's own status rollup, plus the commit it was read at.
  // A non-null `baseHealthError` means the read failed and the base's health
  // is unknown; both feed the `base-red` blocker below.
  baseStatusCheckRollup = [],
  baseHealthOid = null,
  baseHealthError = null,
  includeFeedbackDetails = false,
  codeRabbitPathFilterSkip = null,
  // Wall-clock "now" for the closeout waits. Not the caller's `observedAt`
  // floor from the status reads, which is the oldest check timestamp.
  now = Date.now(),
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
    HUMAN_OVERRIDE_ASSOCIATIONS,
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
  const codeRabbitReviewSignal = classifyCodeRabbitReviewSignal({
    issueComments,
    reviews: pr.reviews ?? [],
    headUpdatedAt,
    currentHeadOid,
    pathFilterSkip: codeRabbitPathFilterSkip,
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
  const notes = [];

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

  // `mergeable: CONFLICTING` normally implies `mergeStateStatus: DIRTY`, so
  // the check above already blocks it. Check DIRTY independently so a
  // conflict still blocks even if GitHub reports a stale `mergeable` value.
  if (mergeable && normalizeStatusValue(pr.mergeStateStatus) === "DIRTY") {
    requiredBlockers.push({
      kind: "mergeability",
      name: "Pull request has a merge conflict with the base",
      state: "DIRTY",
      required: true,
      url: pr.url,
    });
  }

  if (normalizeStatusValue(pr.mergeStateStatus) === "BEHIND") {
    // Non-strict policy (operator decision 2026-09-15, ADR 0103): once the
    // base's ruleset confirms `strict_required_status_checks_policy: false`,
    // a PR merely behind the base is not a required blocker on its own. A
    // textual conflict still blocks via the `mergeable` check above (kind
    // "mergeability") or GitHub's `mergeStateStatus: DIRTY`. Until strict is
    // confirmed off, fail closed and keep blocking, exactly as GitHub does.
    if (requiredStatusChecksStrict === false) {
      notes.push({
        kind: "base-update",
        name: "Pull request is behind the current base",
        state: "BEHIND",
        required: false,
        url: pr.url,
      });
    } else {
      requiredBlockers.push({
        kind: "base-update",
        name: "Pull request must include the current base before merge",
        state: "BEHIND",
        required: true,
        url: pr.url,
      });
    }
  }

  // ADR 0103 stopped GitHub re-running a PR's required checks against the
  // current base, so "nobody merges while main is red" needs an enforced
  // blocker rather than a rule of thumb. Judge the base head by the same
  // required-contexts set and the same fail/pending/pass classification the
  // PR's own checks get: only a failed, cancelled, timed-out or
  // action-required conclusion is red; pending, in-progress and skipped are
  // not. An unreadable base leaves its health unknown and blocks too. The
  // caller has already reduced the rollup to the latest run per check, so a
  // rerun that fixed the base does not keep blocking here.
  if (baseHealthError !== null) {
    requiredBlockers.push({
      kind: "base-red",
      // Stable name, diagnostic in `state`, like the branch-protection
      // blocker. A transport error carries the whole GraphQL query and
      // stderr, so collapse it: `formatCompact` emits one physical line per
      // summary and callers quote that line verbatim (scripts/AGENTS.md
      // "Compact/watch scripts keep machine state ... separate from display
      // strings").
      name: "Base branch health unavailable",
      state: `unknown: ${compactDiagnostic(baseHealthError)}`,
      required: true,
      url: pr.url,
    });
  } else {
    const redBaseChecks = splitRequiredAndOptionalChecks(
      baseStatusCheckRollup,
      requiredStatusContexts,
      { requiredStatusContextsAvailable },
    ).required.filter((check) => check.state === "fail");
    for (const check of redBaseChecks) {
      requiredBlockers.push({
        kind: "base-red",
        name: `Base check ${check.name} is red at ${baseHealthOid ?? "an unknown base commit"}`,
        state: "red",
        required: true,
        url: check.url ?? pr.url,
      });
    }
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
    codeRabbitReviewSignal: summarizeCodeRabbitReviewGate(
      codeRabbitReviewSignal,
      codeRabbitPathFilterSkip,
      {
        mergeStateStatus: pr.mergeStateStatus ?? null,
        requiredStatusChecksStrict,
        // CodeRabbit registers a check run while it reviews; the pending group
        // already classifies status-only runs as pending.
        reviewRunning: statusChecks.pending.some(
          (check) => String(check.name).toLowerCase() === "coderabbit",
        ),
        requestCount: countTrustedCodeRabbitReviewRequests(issueComments),
        headUpdatedAt,
        observedAt: now,
      },
    ),
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
    notes,
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
    codeRabbitReviewSignal,
    requiredStatusChecksStrict,
  };

  if (includeFeedbackDetails) {
    readyStateSummary.reviewThreads = reviewThreadSummaries;
    readyStateSummary.rootReviewComments = rootReviewComments;
  }

  return readyStateSummary;
}
