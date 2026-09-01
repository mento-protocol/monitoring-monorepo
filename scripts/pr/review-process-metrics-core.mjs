const CODEX_BOT_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const CLAUDE_BOT_LOGINS = new Set(["claude", "claude[bot]"]);
const CODERABBIT_BOT_LOGINS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const CURSOR_BOT_LOGINS = new Set(["cursor", "cursor[bot]"]);
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const TRUSTED_REQUEST_AUTHORS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
  "claude",
  "claude[bot]",
]);

const BOT_DEFINITIONS = [
  { key: "coderabbit", logins: CODERABBIT_BOT_LOGINS },
  { key: "codex", logins: CODEX_BOT_LOGINS },
  { key: "claude", logins: CLAUDE_BOT_LOGINS },
  { key: "cursor", logins: CURSOR_BOT_LOGINS },
];
export const REVIEW_BOT_KEYS = Object.freeze(
  BOT_DEFINITIONS.map(({ key }) => key),
);

const REVIEW_BOT_LOGINS = new Set(
  BOT_DEFINITIONS.flatMap(({ logins }) => [...logins]),
);
const DISPOSITIONS = [
  "fixed",
  "wont_fix",
  "bot_conceded",
  "unclassified",
  "unknown",
];
const SURFACES = ["issue_comments", "review_submissions", "review_comments"];

export function authorLogin(value) {
  return String(value?.author?.login ?? value?.user?.login ?? "").toLowerCase();
}

function authorAssociation(value) {
  return String(
    value?.author_association ?? value?.authorAssociation ?? "",
  ).toUpperCase();
}

function isPrAuthor(value, prAuthorLogin) {
  return (
    Boolean(prAuthorLogin) &&
    authorLogin(value) === String(prAuthorLogin).toLowerCase()
  );
}

function isKnownLogin(login, logins) {
  return logins.has(String(login ?? "").toLowerCase());
}

export function botKeyForLogin(login) {
  return (
    BOT_DEFINITIONS.find(({ logins }) => isKnownLogin(login, logins))?.key ??
    null
  );
}

export function isTrustedRequestAuthor(value) {
  return (
    TRUSTED_ASSOCIATIONS.has(authorAssociation(value)) ||
    TRUSTED_REQUEST_AUTHORS.has(authorLogin(value))
  );
}

export function isReviewBotLogin(login) {
  return isKnownLogin(login, REVIEW_BOT_LOGINS);
}

export function isCodexBotLogin(login) {
  return isKnownLogin(login, CODEX_BOT_LOGINS);
}

export function isClaudeBotLogin(login) {
  return isKnownLogin(login, CLAUDE_BOT_LOGINS);
}

export function isFindingLikeText(value) {
  const body = String(value ?? "");
  return (
    /\[[Pp][0-3]\]/.test(body) ||
    /\b[Pp][0-3]\s+Badge\b/.test(body) ||
    /\bBUGBOT_BUG_ID\b/.test(body) ||
    /<!--\s*cr-indicator-types\s*:/i.test(body) ||
    /_\s*(?:\p{Extended_Pictographic}️?\s*)?(?:Critical|Major|Minor|Trivial)\s*_/u.test(
      body,
    ) ||
    /\bchanges requested\b/i.test(body) ||
    /\b(?:critical|high|medium|low) severity\b/i.test(body) ||
    /\bfindings?\b/i.test(body)
  );
}

function containsNegation(value) {
  return (
    /\b(?:no|not|without|zero|never|none|neither|cannot)\b/i.test(value) ||
    /\b(?:did|do|does|is|are|was|were|has|have|had|ca|could|would|should|wo)n['’]t\b/i.test(
      value,
    )
  );
}

function isExplicitEmptySummary(value) {
  return /^\s*(?:findings?\s*)?(?::|[—-])\s*(?:none|zero|no\s+findings?)\b/i.test(
    value,
  );
}

const FINDING_LABEL_SOURCE = String.raw`(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b|\b(?:critical|high|medium|low)\s+severity\b|\bchanges requested\b)`;
const FINDING_LABEL_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:and|or)\b|[/,]|\b(?:and|or)\b)`;
const FINDING_LABEL_LIST_SOURCE = String.raw`${FINDING_LABEL_SOURCE}(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*${FINDING_LABEL_SOURCE})*`;
const EMPTY_FINDING_PREFIX_SOURCE = String.raw`(?:0|zero|none|no)`;
const EMPTY_FINDING_SUFFIX_SOURCE = String.raw`(?:0|zero|none|no\s+findings?)`;
const EMPTY_FINDING_ENTRY_SOURCE = String.raw`(?:${EMPTY_FINDING_PREFIX_SOURCE}\s*(?:findings?\s*)?(?:(?::|[—–-])\s*)?${FINDING_LABEL_LIST_SOURCE}(?:\s+findings?)?|${FINDING_LABEL_LIST_SOURCE}\s*(?:findings?\s*)?(?::|[—–-])\s*${EMPTY_FINDING_SUFFIX_SOURCE}(?:\s+findings?)?)`;
const EMPTY_FINDING_ENTRY_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:and|or)\b|[—–,-]|\b(?:and|or)\b)`;
const EMPTY_FINDING_SUMMARY = new RegExp(
  String.raw`^\s*(?:(?:[-+•>]|#{1,6})\s+)*${EMPTY_FINDING_ENTRY_SOURCE}(?:\s*${EMPTY_FINDING_ENTRY_SEPARATOR_SOURCE}\s*${EMPTY_FINDING_ENTRY_SOURCE})*\s*,?\s*$`,
  "i",
);

function isEmptyFindingSummaryClause(value) {
  const normalized = String(value ?? "")
    .replace(/[*_`~]/g, "")
    .trim();
  if (EMPTY_FINDING_SUMMARY.test(normalized)) return true;
  if (!normalized.startsWith("|") || !normalized.endsWith("|")) return false;
  const cells = normalized
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return (
    cells.length === 2 && EMPTY_FINDING_SUMMARY.test(`${cells[0]}: ${cells[1]}`)
  );
}

function affirmativeOccurrence(body, pattern) {
  const text = String(body ?? "");
  const match = [...text.matchAll(pattern)].find((candidate) => {
    const matchIndex = candidate.index ?? 0;
    const matchEnd = matchIndex + candidate[0].length;
    const boundary = /[.!?;\n]|\b(?:although|but|however|yet)\b/i;
    const prefix = text.slice(0, matchIndex).split(boundary).at(-1) ?? "";
    const suffix = text.slice(matchEnd).split(boundary)[0] ?? "";
    const clause = `${prefix}${candidate[0]}${suffix}`;
    return (
      !containsNegation(prefix) &&
      !isExplicitEmptySummary(suffix) &&
      !isEmptyFindingSummaryClause(clause)
    );
  });
  return match?.[0] ?? null;
}

function affirmativeChangesRequested(body) {
  return affirmativeOccurrence(body, /\bchanges requested\b/gi);
}

function affirmativeSeverity(body) {
  return affirmativeOccurrence(
    body,
    /\b(?:critical|high|medium|low) severity\b/gi,
  );
}

function affirmativePriority(body) {
  return affirmativeOccurrence(
    body,
    /(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b)/gi,
  );
}

function actionableFindingSignal(value, bot, { reviewState = null } = {}) {
  const body = String(value ?? "");
  if (String(reviewState ?? "").toUpperCase() === "CHANGES_REQUESTED") {
    return "review state: CHANGES_REQUESTED";
  }
  if (bot === "coderabbit") {
    return (
      body.match(/<!--\s*cr-indicator-types\s*:[^>]{1,120}-->/i)?.[0] ??
      body.match(
        /_\s*(?:\p{Extended_Pictographic}️?\s*)?(?:Critical|Major|Minor|Trivial)\s*_/u,
      )?.[0] ??
      null
    );
  }
  if (bot === "cursor") return body.match(/\bBUGBOT_BUG_ID\b/)?.[0] ?? null;
  return (
    affirmativePriority(body) ??
    affirmativeSeverity(body) ??
    affirmativeChangesRequested(body)
  );
}

export function isCodexUsageLimit(value) {
  return /codex usage limits have been reached/i.test(String(value ?? ""));
}

export function isCodexApprovalComment(value) {
  return /codex review:\s+did(?:n['’]?t| not) find any major issues/i.test(
    String(value ?? ""),
  );
}

export function isClaudeSummary(value) {
  return /claude finished|pr review(?:\s*[:\u2014-]|$)/i.test(
    String(value ?? ""),
  );
}

function normalizedExcerpt(body) {
  return String(body ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function evidenceUrl(value, prUrl) {
  return value.html_url ?? value.url ?? prUrl ?? null;
}

function createdAt(value) {
  return (
    value.createdAt ??
    value.created_at ??
    value.submittedAt ??
    value.submitted_at ??
    null
  );
}

export function baseEvidence(
  value,
  { prUrl, surface, finding = false, findingSignal = null },
) {
  return {
    id: String(value.id ?? value.node_id ?? "unknown"),
    url: evidenceUrl(value, prUrl),
    author: authorLogin(value) || null,
    authorAssociation:
      value.author_association ?? value.authorAssociation ?? null,
    surface,
    createdAt: createdAt(value),
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
    path: value.path ?? null,
    finding,
    ...(findingSignal === null ? {} : { findingSignal }),
    excerpt: normalizedExcerpt(value.body),
  };
}

function isTrustedHumanReply(reply, prAuthorLogin) {
  const login = authorLogin(reply);
  const type = String(
    reply?.user?.type ?? reply?.author?.type ?? "",
  ).toLowerCase();
  if (isReviewBotLogin(login) || type === "bot" || login.endsWith("[bot]")) {
    return false;
  }
  return (
    isPrAuthor(reply, prAuthorLogin) ||
    TRUSTED_ASSOCIATIONS.has(authorAssociation(reply))
  );
}

function humanClassification(body) {
  const text = String(body ?? "");
  const fixed = text.match(/^\s*(Fixed in\s+`?[0-9a-f]{7,40}`?\s+[—-])\s+\S/im);
  if (fixed) {
    return { category: "fixed", signal: fixed[1] };
  }
  const wontFix = text.match(/^\s*(Won['’]t fix:)\s+\S/im);
  if (wontFix) {
    return { category: "wont_fix", signal: wontFix[1] };
  }
  return null;
}

const BOT_STANCE_PATTERNS = {
  concession: [
    String.raw`I\s+(?:am\s+withdrawing|withdraw)\s+(?:this|the)\s+finding`,
    String.raw`(?:this|the)\s+finding\s+(?:is|was)\s+withdrawn`,
    String.raw`(?:this|the)\s+finding\s+does\s+not\s+apply`,
    String.raw`(?:(?:agreed|I agree|you(?:'re| are) right)\s*[,:—-]\s*)?(?:this|it)\s+(?:is|was)\s+(?:indeed\s+)?a\s+false positive`,
  ],
  restoration: [
    String.raw`(?:this|it)\s+(?:is|was)\s+not\s+a\s+false positive`,
    String.raw`(?:this|the)\s+finding\s+(?:still\s+)?applies`,
    String.raw`I\s+(?:still\s+)?stand\s+by\s+(?:this|the)\s+finding`,
    String.raw`(?:this|the)\s+finding\s+(?:is|was)\s+not\s+withdrawn`,
    String.raw`I\s+(?:do\s+not|don't)\s+withdraw\s+(?:this|the)\s+finding`,
  ],
};

function explicitBotStances(body) {
  const sentenceBoundary =
    String.raw`(?:^|[.!?]\s+|\n)\s*(?:` + String.raw`@[^\s,]+,?\s*)?`;
  const sentenceEnd = String.raw`(?=\s*(?:[.!]|$|\n))`;
  const text = String(body ?? "");
  return Object.entries(BOT_STANCE_PATTERNS)
    .flatMap(([stance, patterns]) =>
      patterns.flatMap((pattern) =>
        [
          ...text.matchAll(
            new RegExp(`${sentenceBoundary}(${pattern})${sentenceEnd}`, "gim"),
          ),
        ].map((match) => ({
          stance,
          index: match.index ?? 0,
          signal: match[1],
        })),
      ),
    )
    .sort((left, right) => left.index - right.index);
}

function orderedSameBotStances(replies, findingBot) {
  return replies
    .flatMap((reply, replyIndex) => {
      if (botKeyForLogin(authorLogin(reply)) !== findingBot) return [];
      const replyTime = Date.parse(createdAt(reply) ?? "");
      return explicitBotStances(reply.body).map(
        ({ stance, index, signal }) => ({
          stance,
          index,
          signal,
          reply,
          replyIndex,
          replyTime: Number.isFinite(replyTime) ? replyTime : Infinity,
        }),
      );
    })
    .sort(
      (left, right) =>
        left.replyTime - right.replyTime ||
        left.replyIndex - right.replyIndex ||
        left.index - right.index,
    );
}

function classifyInlineDisposition(replies, prUrl, findingBot, prAuthorLogin) {
  const nonBotReplies = replies.filter(
    (reply) => !isReviewBotLogin(authorLogin(reply)),
  );
  const humanReplies = nonBotReplies.filter((reply) =>
    isTrustedHumanReply(reply, prAuthorLogin),
  );
  const untrustedReplies = nonBotReplies.filter(
    (reply) => !isTrustedHumanReply(reply, prAuthorLogin),
  );
  const classified = humanReplies
    .map((reply) => ({
      reply,
      classification: humanClassification(reply.body),
    }))
    .filter(({ classification }) => classification !== null);
  const categories = new Set(
    classified.map(({ classification }) => classification.category),
  );
  const botStances = orderedSameBotStances(replies, findingBot);
  const finalBotStance = botStances.reduce((effectiveStance, { stance }) => {
    if (stance === "concession") return "concession";
    return effectiveStance === null ? null : "restoration";
  }, null);
  const evidence = classified.map(({ reply, classification }) => ({
    ...baseEvidence(reply, {
      prUrl,
      surface: "review_comments",
    }),
    category: classification.category,
    dispositionSignal: classification.signal,
  }));
  const stanceEvidence = (stance) => {
    const matchesByReply = new Map();
    for (const item of botStances) {
      if (item.stance !== stance || matchesByReply.has(item.reply)) continue;
      matchesByReply.set(item.reply, item);
    }
    return [...matchesByReply.values()].map(({ reply, signal }) => ({
      ...baseEvidence(reply, { prUrl, surface: "review_comments" }),
      dispositionSignal: signal,
    }));
  };
  const untrustedReplyEvidence = untrustedReplies.map((reply) => {
    const classification = humanClassification(reply.body);
    return {
      ...baseEvidence(reply, { prUrl, surface: "review_comments" }),
      claimedCategory: classification?.category ?? null,
      ...(classification === null
        ? {}
        : { dispositionSignal: classification.signal }),
    };
  });
  const classificationEvidence = {
    humanClassificationEvidence: evidence,
    botConcessionEvidence: stanceEvidence("concession"),
    botRestorationEvidence: stanceEvidence("restoration"),
    untrustedReplyEvidence,
  };

  if (categories.size > 1) {
    return {
      disposition: "unknown",
      reason: "conflicting_human_classifications",
      ...classificationEvidence,
    };
  }
  if (categories.has("fixed")) {
    return {
      disposition: "fixed",
      reason: "explicit_human_fixed_reply",
      ...classificationEvidence,
    };
  }
  if (categories.has("wont_fix") && finalBotStance === "concession") {
    return {
      disposition: "bot_conceded",
      reason: "human_wont_fix_and_bot_withdrew",
      ...classificationEvidence,
    };
  }
  if (categories.has("wont_fix")) {
    return {
      disposition: "wont_fix",
      reason: "explicit_human_wont_fix_reply",
      ...classificationEvidence,
    };
  }
  if (finalBotStance === "concession") {
    return {
      disposition: "bot_conceded",
      reason: "bot_withdrew_finding",
      ...classificationEvidence,
    };
  }
  if (finalBotStance === "restoration") {
    return {
      disposition: "unknown",
      reason: "bot_restored_finding_without_human_classification",
      ...classificationEvidence,
    };
  }
  if (humanReplies.length > 0) {
    return {
      disposition: "unknown",
      reason: "human_reply_has_no_supported_classification",
      ...classificationEvidence,
    };
  }
  if (nonBotReplies.length > 0) {
    return {
      disposition: "unknown",
      reason: "reply_author_is_not_trusted",
      ...classificationEvidence,
    };
  }
  return {
    disposition: "unclassified",
    reason: "no_human_classification",
    ...classificationEvidence,
  };
}

function unthreadedDisposition() {
  return {
    disposition: "unknown",
    reason: "surface_has_no_structured_reply_link",
    humanClassificationEvidence: [],
    botConcessionEvidence: [],
    botRestorationEvidence: [],
    untrustedReplyEvidence: [],
  };
}

function emptyDispositionTotals() {
  return Object.fromEntries(DISPOSITIONS.map((category) => [category, 0]));
}

function emptySurface() {
  return { records: 0, findings: 0, evidence: [] };
}

function emptyBotEvidence() {
  return {
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [surface, emptySurface()]),
    ),
    dispositions: emptyDispositionTotals(),
  };
}

function addEvidenceRecord(botEvidence, surface, record) {
  const target = botEvidence.surfaces[surface];
  target.records += 1;
  if (record.finding) {
    target.findings += 1;
    botEvidence.dispositions[record.disposition] += 1;
  }
  target.evidence.push(record);
}

export function buildPerBotEvidence({
  prUrl,
  prAuthorLogin,
  issueComments,
  reviews,
  reviewComments,
}) {
  const byBot = Object.fromEntries(
    BOT_DEFINITIONS.map(({ key }) => [key, emptyBotEvidence()]),
  );
  const repliesByRoot = new Map();
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id == null) continue;
    const replies = repliesByRoot.get(comment.in_reply_to_id) ?? [];
    replies.push(comment);
    repliesByRoot.set(comment.in_reply_to_id, replies);
  }

  for (const comment of issueComments) {
    const bot = botKeyForLogin(authorLogin(comment));
    if (!bot) continue;
    const findingSignal = actionableFindingSignal(comment.body, bot);
    const finding = findingSignal !== null;
    addEvidenceRecord(byBot[bot], "issue_comments", {
      ...baseEvidence(comment, {
        prUrl,
        surface: "issue_comments",
        finding,
        findingSignal,
      }),
      ...(finding ? unthreadedDisposition() : {}),
    });
  }
  for (const review of reviews) {
    const bot = botKeyForLogin(authorLogin(review));
    if (!bot) continue;
    const findingSignal = actionableFindingSignal(review.body, bot, {
      reviewState: review.state,
    });
    const finding = findingSignal !== null;
    addEvidenceRecord(byBot[bot], "review_submissions", {
      ...baseEvidence(review, {
        prUrl,
        surface: "review_submissions",
        finding,
        findingSignal,
      }),
      state: review.state ?? null,
      commitId: review.commit_id ?? review.commitId ?? null,
      ...(finding ? unthreadedDisposition() : {}),
    });
  }
  for (const comment of reviewComments) {
    const bot = botKeyForLogin(authorLogin(comment));
    if (!bot) continue;
    const isRoot = comment.in_reply_to_id == null;
    const findingSignal = isRoot
      ? actionableFindingSignal(comment.body, bot)
      : null;
    const finding = findingSignal !== null;
    const disposition = finding
      ? classifyInlineDisposition(
          repliesByRoot.get(comment.id) ?? [],
          prUrl,
          bot,
          prAuthorLogin,
        )
      : {};
    addEvidenceRecord(byBot[bot], "review_comments", {
      ...baseEvidence(comment, {
        prUrl,
        surface: "review_comments",
        finding,
        findingSignal,
      }),
      inReplyToId:
        comment.in_reply_to_id == null ? null : String(comment.in_reply_to_id),
      ...disposition,
    });
  }
  return byBot;
}
