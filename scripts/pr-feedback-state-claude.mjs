import { createHash } from "node:crypto";

const COMMONMARK_ASCII_PUNCTUATION_ESCAPE =
  /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;
const CLAUDE_TASK_COMPLETION_LINE =
  /^\*\*Claude\s+finished\s+@[A-Za-z0-9_-]+'s\s+task\s+in\s+\d+m\s+\d+s\*\*(?:\s+——\s+\[View\s+job\]\(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\))?$/i;
const CLAUDE_VERDICT_NAMESPACE = /^(?:\*\*)?(?:Overall\s+)?Verdict\s*:/i;
const CLAUDE_CLEAN_VERDICT =
  /^(?:\*\*)?(?:Overall\s+)?Verdict:\s*LGTM(?:\*\*)?\s*$/i;
const PROSE_PATTERN_LIBRARY_START = Date.parse("2026-08-13T23:08:10Z");
const REVIEW_NUMBER_HEADING = /^#{1,6}\s+Code Review\s+—\s+PR\s+#(\d+)$/gm;
const REVIEW_TITLE_HEADING = /^#{1,6}\s+Review:\s+(.{1,200})$/gim;
const CLEAN_CONCLUSION_PATTERNS = [
  /^No\s+P1\/P2\/P3\s+findings(?:\s*[.—-]\s*(?:clean review|nothing rose above the bar for an inline comment))?[.!]?$/i,
  /^No\s+P1\/P2\s+findings[.!]?$/i,
  /^No\s+inline\s+(?:comments|findings)(?:\s+(?:filed|posted))?(?:\s*[.—-]\s*nothing rose to a P1\/P2\/P3 flag)?[.!]?$/i,
  /^No\s+changes\s+requested[.!]?$/i,
];
const CLEAN_P3_DISPOSITION_PATTERNS = [
  /\bno[- ]action(?:\s+requested)?\b/i,
  /\bnone\s+blocking\b/i,
  /\bnot\s+(?:a\s+)?blocker\b/i,
  /\bisn['’]t\s+(?:a\s+)?blocker\b/i,
  /\bnot\s+worth\s+(?:a\s+)?fix\b/i,
  /\bnot\s+an?\s+(?:error|issue)\b/i,
];
const EXPLICIT_ACTION_LINE =
  /^(?:\*\*)?(?:Action\s+(?:items?|required)|Changes\s+requested|Needs\s+changes|A\s+fix\s+is\s+required|.{1,160}\s+must\s+be\s+(?:addressed|changed|fixed|implemented|removed|restored|updated|validated)|(?:Please\s+)?(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)|(?:Must|Should|Needs?\s+to)\s+(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate))\b/i;
const INLINE_DIRECT_ACTION =
  /\bplease\s+(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)\b/i;
// `cr-indicator-types` is CodeRabbit's finding marker and the counterpart to
// Cursor's BUGBOT_BUG_ID: a Claude LGTM verdict that quotes or relays one is
// not an explicitly clean review.
const EXPLICIT_SEVERITY =
  /(?:BUGBOT_BUG_ID|<!--\s*cr-indicator-types\s*:|\b(?:Critical|High|Medium|Low)\s+Severity\b|\bSeverity\s*:\s*(?:Critical|High|Medium|Low)\b)/i;
const CLEAN_REVIEW_COMPATIBILITY = new Map([
  [
    "039923882eee9f880165543ef85e1ca251d84b995a78647b41c2b788d02a4885",
    {
      author: "claude[bot]",
      prNumber: "1544",
      commentId: "5060594122",
      headRefOid: "aab83bc74ae0585147a058d92f1f13afac7be109",
    },
  ],
  [
    "5d4832d96803f81363bc0842a4c1aed89e8fb526cb83834d3373aacd30c5be34",
    {
      author: "claude[bot]",
      prNumber: "1595",
      commentId: "5069799124",
      headRefOid: "d4bb77845e635c72b61fa56b375ec3f44b05702e",
    },
  ],
  [
    "e0394033c85a77330e2ee53cab690a2069263c7e792ab3e443c17949bb728db4",
    {
      author: "claude[bot]",
      prNumber: "1600",
      commentId: "5073384440",
      headRefOid: "0ff2700ecbec8d2877caeeaa91bf423cf8fdc2f0",
    },
  ],
  [
    "17628badc56cb6e53b77c559425020b839847e66357614e65a9707f8bf6d7ee9",
    {
      author: "claude[bot]",
      prNumber: "1825",
      commentId: "5278516901",
      headRefOid: "5ce1cad0371551aff0e8b68867a29bb5d2736bf4",
    },
  ],
  [
    "3816022eb21a2e41e0617c719f6daedc8c1c5c282b4b1b2010e4b739b0c3f1c7",
    {
      author: "claude[bot]",
      prNumber: "1837",
      commentId: "5281908631",
      headRefOid: "7d982e05a0256d73d0d7aeafc485dfad338e63ce",
    },
  ],
]);

function normalizedReviewTitle(value) {
  return String(value ?? "")
    .replace(COMMONMARK_ASCII_PUNCTUATION_ESCAPE, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isClaudeAuthor(value) {
  return /^claude(?:\[bot\])?$/i.test(String(value ?? ""));
}

function isCleanConclusion(line) {
  const value = String(line ?? "").trim();
  return CLEAN_CONCLUSION_PATTERNS.some((pattern) => pattern.test(value));
}

export function withoutCleanReviewConclusionLines(value) {
  return String(value ?? "")
    .split("\n")
    .filter((line) => !isCleanConclusion(line))
    .join("\n");
}

function reviewLineContent(line) {
  let value = String(line ?? "").trim();
  for (let index = 0; index < 3; index += 1) {
    const stripped = value.replace(
      /^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|\[[ xX-]\]\s+)/,
      "",
    );
    if (stripped === value) break;
    value = stripped;
  }
  return value;
}

function verdictDeclaration(line) {
  return CLAUDE_VERDICT_NAMESPACE.test(reviewLineContent(line));
}

function priorityAtLineStart(line) {
  return reviewLineContent(line).match(
    /^(?:\*\*)?\[?[Pp]([0-3])\]?(?:\*\*)?(?=[^A-Za-z0-9]|$)/,
  )?.[1];
}

function hasCleanP3Disposition(line) {
  return CLEAN_P3_DISPOSITION_PATTERNS.some((pattern) => pattern.test(line));
}

function hasExplicitAction(line) {
  const content = reviewLineContent(line).replace(
    /^(?:\*\*)?\[?[Pp][0-3]\]?(?:\*\*)?(?:\s*[^A-Za-z0-9\s]\s*|\s+)/,
    "",
  );
  return (
    EXPLICIT_ACTION_LINE.test(content) || INLINE_DIRECT_ACTION.test(content)
  );
}

export function hasControlCharacter(value) {
  return Array.from(String(value ?? "")).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

export function isOrdinaryReviewTitle(value, expectedTitle) {
  const title = String(value ?? "").trim();
  if (
    !title ||
    title.length > 200 ||
    hasControlCharacter(title) ||
    /<!--|-->/.test(title)
  )
    return false;
  const normalized = normalizedReviewTitle(title);
  return (
    normalized.length > 0 && normalized === normalizedReviewTitle(expectedTitle)
  );
}

export function hasMarkdownCodeBlockIndentation(lines) {
  return lines.some((line) => line.trim() && /^(?: {4}| {0,3}\t)/.test(line));
}

export function isClaudeTaskCompletionLine(value) {
  return CLAUDE_TASK_COMPLETION_LINE.test(String(value ?? ""));
}

export function isClaudeLgtmReview(comment) {
  return (
    isClaudeAuthor(comment?.author) &&
    /^\s*(?:#{1,6}\s+)?(?:\*\*)?Verdict:\s*LGTM(?:\*\*)?\s*$/im.test(
      comment?.body ?? "",
    )
  );
}

export function matchesCleanReviewCompatibilityRegistry(comment, pr, rawBody) {
  const digest = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const registered = CLEAN_REVIEW_COMPATIBILITY.get(digest);
  return (
    registered !== undefined &&
    String(comment?.author ?? "").toLowerCase() === registered.author &&
    String(pr?.number ?? "") === registered.prNumber &&
    String(comment?.id ?? "") === registered.commentId &&
    String(pr?.headRefOid ?? "") === registered.headRefOid
  );
}

// Returns null for non-Claude or non-verdict comments, false for an explicitly
// clean review, and true for an actionable or unsupported verdict comment.
export function classifyClaudeReviewProse(comment, pr) {
  if (!isClaudeAuthor(comment?.author)) return null;
  const body = String(comment?.body ?? "");
  const lines = body.split("\n");
  const verdictLines = lines.filter(verdictDeclaration);
  if (verdictLines.length === 0) return null;
  const createdAt = Date.parse(comment?.createdAt ?? comment?.created_at ?? "");
  if (!Number.isFinite(createdAt) || createdAt < PROSE_PATTERN_LIBRARY_START)
    return true;

  if (
    verdictLines.length !== 1 ||
    !CLAUDE_CLEAN_VERDICT.test(reviewLineContent(verdictLines[0])) ||
    body.includes("\r") ||
    body.includes("\0") ||
    body.length > 65_536 ||
    hasMarkdownCodeBlockIndentation(lines) ||
    /(?:^|\s)(?:```|~~~)|<!--|-->|^\s*(?:>|\|.*\|\s*$)/m.test(body)
  )
    return true;

  const reviewNumbers = Array.from(
    body.matchAll(REVIEW_NUMBER_HEADING),
    ([, number]) => number,
  );
  if (
    reviewNumbers.length > 1 ||
    (reviewNumbers.length === 1 &&
      reviewNumbers[0] !== String(pr?.number ?? ""))
  )
    return true;

  const reviewTitles = Array.from(
    body.matchAll(REVIEW_TITLE_HEADING),
    ([, title]) => title,
  );
  if (
    reviewTitles.length > 1 ||
    (reviewTitles.length === 1 &&
      !isOrdinaryReviewTitle(reviewTitles[0], pr?.title))
  )
    return true;

  if (!lines.some(isCleanConclusion)) return true;

  for (const line of lines) {
    if (isCleanConclusion(line)) continue;
    const priority = priorityAtLineStart(line);
    if (
      priority !== undefined &&
      (priority !== "3" || !hasCleanP3Disposition(line))
    )
      return true;
    if (hasExplicitAction(line) || EXPLICIT_SEVERITY.test(line)) return true;
  }

  return false;
}
