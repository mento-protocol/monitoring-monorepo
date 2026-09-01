import { actionableFindingSignal } from "./review-process-metrics-finding-classifier.mjs";
import { maskMarkdownNonProse } from "./review-process-metrics-markdown.mjs";

const CODEX_BOT_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const CLAUDE_BOT_LOGINS = new Set(["claude", "claude[bot]"]);
const GITHUB_ACTIONS_BOT_LOGINS = new Set([
  "github-actions",
  "github-actions[bot]",
]);
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
const CLAUDE_ACTIONS_HEADER =
  /^\*\*Claude finished @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})['’]s task(?: in \d+(?:h|m|s)(?:\s+\d+(?:h|m|s)){0,2})?\*\*/m;
const CLAUDE_ACTIONS_RUN_LINK =
  /\[View job\]\((https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*(?:\/job\/[1-9]\d*)?)\)/i;
const CLAUDE_REVIEW_STRUCTURE =
  /^(?:#{1,6}\s+(?:Claude finished the review|(?:Code\s+)?Review(?::\s*\S|\s+(?:complete|result|summary)\b))|(?:#{1,6}\s+)?\*{0,2}(?:overall\s+)?verdict\*{0,2}\s*:\s*\*{0,2}\S)/im;
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

function githubRepositoryFromUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const [owner, repository, ...rest] = url.pathname
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      !owner ||
      !repository ||
      rest.length === 0
    ) {
      return null;
    }
    return `${owner}/${repository}`.toLowerCase();
  } catch {
    return null;
  }
}

function isCanonicalClaudeActionsReviewBody(value, prUrl) {
  const body = String(value ?? "");
  const runUrl = body.match(CLAUDE_ACTIONS_RUN_LINK)?.[1] ?? null;
  const prRepository = githubRepositoryFromUrl(prUrl);
  return (
    prRepository !== null &&
    CLAUDE_ACTIONS_HEADER.test(body) &&
    githubRepositoryFromUrl(runUrl) === prRepository &&
    CLAUDE_REVIEW_STRUCTURE.test(body)
  );
}

export function isClaudeEvidence(value, prUrl = value?.html_url ?? value?.url) {
  const login = authorLogin(value);
  return (
    isClaudeBotLogin(login) ||
    (isKnownLogin(login, GITHUB_ACTIONS_BOT_LOGINS) &&
      isCanonicalClaudeActionsReviewBody(value?.body, prUrl))
  );
}

export function botKeyForEvidence(
  value,
  prUrl = value?.html_url ?? value?.url,
) {
  return (
    botKeyForLogin(authorLogin(value)) ??
    (isClaudeEvidence(value, prUrl) ? "claude" : null)
  );
}

export function isReviewBotEvidence(
  value,
  prUrl = value?.html_url ?? value?.url,
) {
  return botKeyForEvidence(value, prUrl) !== null;
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
  const text = maskMarkdownNonProse(body, {
    maskRawHtmlNonProse: true,
    preserveInlineCode: true,
  });
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
  const text = maskMarkdownNonProse(body, { maskRawHtmlNonProse: true });
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

function orderedSameBotStances(replies, findingBot, prUrl) {
  return replies
    .flatMap((reply, replyIndex) => {
      if (botKeyForEvidence(reply, prUrl) !== findingBot) return [];
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
    (reply) => !isReviewBotEvidence(reply, prUrl),
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
  const botStances = orderedSameBotStances(replies, findingBot, prUrl);
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
    const bot = botKeyForEvidence(comment, prUrl);
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
    const bot = botKeyForEvidence(review, prUrl);
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
    const bot = botKeyForEvidence(comment, prUrl);
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
