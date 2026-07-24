import { createHash } from "node:crypto";

const COMMONMARK_ASCII_PUNCTUATION_ESCAPE =
  /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;
const CLAUDE_TASK_COMPLETION_LINE =
  /^\*\*Claude\s+finished\s+@[A-Za-z0-9_-]+'s\s+task\s+in\s+\d+m\s+\d+s\*\*(?:\s+——\s+\[View\s+job\]\(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\))?$/i;
const CLAUDE_TASK_COMPLETION_WITH_JOB_LINE =
  /^\*\*Claude\s+finished\s+@[A-Za-z0-9_-]+'s\s+task\s+in\s+\d+m\s+\d+s\*\*\s+——\s+\[View\s+job\]\(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\)$/i;
const OVERALL_REVIEW_HEADING = /^###\s+Code Review\s+—\s+PR\s+#(\d+)$/;
const OVERALL_CHECKLIST_ENTRY = /^-\s+\[([^\]])\]\s+(.{1,200})$/;
const OVERALL_VERDICT = /^\*\*Overall verdict:\s+LGTM\*\*$/;
const OVERALL_SUMMARY_HEADING = /^###\s+Summary$/;
const OVERALL_VERIFICATION_HEADING =
  /^###\s+Verification notes \(no issues found\)$/;
const OVERALL_NOTE = /^([1-9]\d*)\.\s+\*\*(.{1,200})\*\*(?:\s+(.{1,4000}))?$/;
const OVERALL_TERMINAL_CLEAN = /^No P1\/P2\/P3 findings\s+—\s+(.{1,500})$/;
const OVERALL_CLEAN_REVIEW_COMPATIBILITY = new Map([
  [
    "039923882eee9f880165543ef85e1ca251d84b995a78647b41c2b788d02a4885",
    {
      author: "claude[bot]",
      prNumber: "1544",
      commentId: "5060594122",
      headRefOid: "aab83bc74ae0585147a058d92f1f13afac7be109",
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
    /^claude(?:\[bot\])?$/i.test(comment?.author ?? "") &&
    /^\s*(?:\*\*)?Verdict:\s*LGTM(?:\*\*)?\s*$/im.test(comment?.body ?? "")
  );
}

function isBoundedRepoRelativePath(value) {
  const path = String(value ?? "");
  return (
    path.length > 0 &&
    path.length <= 180 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("//") &&
    /^[A-Za-z0-9._/-]+$/.test(path) &&
    path.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function isOverallReviewSubject(value) {
  const reviewPath = String(value ?? "").match(
    /^Review `([^`]+)` changes$/,
  )?.[1];
  return reviewPath !== undefined && isBoundedRepoRelativePath(reviewPath);
}

function hasStructuralMarkdown(value) {
  const line = String(value ?? "");
  return (
    /(?:^|\s)(?:```|~~~)/.test(line) ||
    /^(?:#{1,6}\s|[-+*]\s+|\d+[.)]\s+|>\s*|\|.*\|$)/.test(line)
  );
}

function matchesOverallCompatibilityRegistry(comment, pr, rawBody) {
  const digest = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const registered = OVERALL_CLEAN_REVIEW_COMPATIBILITY.get(digest);
  return (
    registered !== undefined &&
    String(comment?.author ?? "").toLowerCase() === registered.author &&
    String(pr?.number ?? "") === registered.prNumber &&
    String(comment?.id ?? "") === registered.commentId &&
    String(pr?.headRefOid ?? "") === registered.headRefOid
  );
}

export function isExplicitlyCleanOverallClaudeReview(comment, pr) {
  const author = String(comment?.author ?? "").toLowerCase();
  if (author !== "claude" && author !== "claude[bot]") return false;

  const body = String(comment?.body ?? "");
  const lines = body.split(/\r?\n/);
  if (hasMarkdownCodeBlockIndentation(lines)) return false;
  const nonempty = lines.map((line) => line.trim()).filter(Boolean);
  let index = 0;

  if (!CLAUDE_TASK_COMPLETION_WITH_JOB_LINE.test(nonempty[index] ?? ""))
    return false;
  index += 1;
  if (nonempty[index] !== "---") return false;
  index += 1;

  const reviewNumber = nonempty[index]?.match(OVERALL_REVIEW_HEADING)?.[1];
  if (!reviewNumber || reviewNumber !== String(pr?.number ?? "")) return false;
  index += 1;

  const checklist = [];
  while (index < nonempty.length) {
    const entry = nonempty[index].match(OVERALL_CHECKLIST_ENTRY);
    if (!entry) break;
    if (entry[1].toLowerCase() !== "x") return false;
    if (hasControlCharacter(entry[2])) return false;
    checklist.push(entry[2]);
    index += 1;
  }
  if (
    checklist.length < 4 ||
    checklist[0] !== "Gather context (read changed files, diff)" ||
    checklist[1] !== "Understand the request (code review)" ||
    checklist.at(-1) !== "Post findings" ||
    !checklist.slice(2, -1).every(isOverallReviewSubject) ||
    !OVERALL_VERDICT.test(nonempty[index] ?? "")
  )
    return false;
  index += 1;
  if (!OVERALL_SUMMARY_HEADING.test(nonempty[index] ?? "")) return false;
  index += 1;

  const summary = [];
  while (
    index < nonempty.length &&
    !OVERALL_VERIFICATION_HEADING.test(nonempty[index])
  ) {
    summary.push(nonempty[index]);
    index += 1;
  }
  if (
    summary.length === 0 ||
    summary.some(
      (line) => hasControlCharacter(line) || hasStructuralMarkdown(line),
    ) ||
    !OVERALL_VERIFICATION_HEADING.test(nonempty[index] ?? "")
  )
    return false;
  index += 1;

  const notes = [];
  while (index < nonempty.length) {
    const note = nonempty[index].match(OVERALL_NOTE);
    if (!note) break;
    if (
      Number(note[1]) !== notes.length + 1 ||
      !note[3] ||
      hasControlCharacter(note[2]) ||
      hasControlCharacter(note[3]) ||
      hasStructuralMarkdown(note[3])
    )
      return false;
    notes.push(`${note[2]} ${note[3]}`);
    index += 1;
  }
  if (notes.length === 0) return false;

  const terminal = nonempty[index]?.match(OVERALL_TERMINAL_CLEAN);
  if (
    !terminal ||
    index !== nonempty.length - 1 ||
    hasControlCharacter(terminal[1]) ||
    hasStructuralMarkdown(terminal[1])
  )
    return false;
  return matchesOverallCompatibilityRegistry(comment, pr, body);
}

export function classifyOverallClaudeReview(comment, pr) {
  const author = String(comment?.author ?? "").toLowerCase();
  if (
    (author !== "claude" && author !== "claude[bot]") ||
    !/^\s*(?:(?:\*\*)?Overall verdict\s*:|#{1,6}\s+Code Review\s+—\s+PR\s+#|#{1,6}\s+Verification notes\b|No P1\/P2\/P3 findings\b)/im.test(
      comment?.body ?? "",
    )
  )
    return null;
  return !isExplicitlyCleanOverallClaudeReview(comment, pr);
}
