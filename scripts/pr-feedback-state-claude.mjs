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
const CLEAN_ATTESTATION_NAMESPACE_CANDIDATE = /mento-claude-review/i;
const CLEAN_ATTESTATION_MARKER =
  /^<!-- mento-claude-review:v1 verdict=lgtm findings=0 pr=([1-9]\d*) head=([0-9a-f]{40}) -->$/;
const CLEAN_ATTESTATION_VERDICT = "**Overall verdict: LGTM**";
const CLEAN_ATTESTATION_ROLLUP = "### Roll-up";
const CLEAN_ATTESTATION_NO_FINDINGS = "No actionable findings.";
const CLEAN_ATTESTATION_VERDICT_CANDIDATE =
  /^\s*(?:>\s*)?(?:\*\*)?Overall verdict\b/i;
const CLEAN_ATTESTATION_PRIORITY_TAG =
  /(?:^|[^A-Za-z0-9_])[Pp][0-3](?=$|[^A-Za-z0-9_])/;
const CLEAN_ATTESTATION_SEVERITY =
  /\b(?:(?:Critical|High|Medium|Low)\s+Severity|Severity\s*:\s*(?:Critical|High|Medium|Low))\b/i;
const CLEAN_ATTESTATION_NON_CLEAN_VERDICT =
  /\b(?:needs?|requires?)[- ](?:changes?|discussion)\b/i;
const CLEAN_ATTESTATION_CLEAN_NEGATION =
  /\b(?:no\s+(?:(?:code|test|documentation|workflow)\s+)?changes?\s+(?:are\s+)?(?:needed|required|requested)|no\s+action(?:s|\s+items?)?\s+(?:(?:is|are)\s+)?(?:needed|required|requested)|(?:the\s+)?fix\s+does\s+not\s+require\s+changes|no\s+P1\/P2\/P3\s+findings(?:\s+(?:are|were)\s+found)?)\b/gi;
const CLEAN_ATTESTATION_ACTION_REQUEST =
  /\b(?:changes?\s+(?:(?:is|are)\s+)?(?:needed|required|requested)|request(?:s|ed|ing)?\s+(?:an?\s+)?(?:action|change)|action\s+(?:required|requested|items?)|please\s+(?:add|address|change|ensure|fix|implement|prevent|reject|remove|restore|update|validate))\b/i;
const CLEAN_ATTESTATION_DIRECTIVE =
  /(?:^|[\r\n])\s*(?:[-*>]\s*)?(?:(?:(?:you|we)\s+)?(?:must|should|need(?:s)?\s+to)\s+)?(?:add|address|change|ensure|fix|implement|prevent|reject|remove|restore|update|validate)\b(?!\s+(?:is|are|was|were)\b)(?!\s+[A-Za-z0-9_-]+\s+(?:is|are|was|were)\b)/i;
const CLEAN_ATTESTATION_MODAL_ACTION =
  /\b(?:must|(?:you|we)\s+(?:must|should|need(?:s)?\s+to))\s+(?:add|address|change|ensure|fix|implement|prevent|reject|remove|restore|update|validate)\b/i;
const CLEAN_ATTESTATION_CONTRAST_ACTION =
  /\b(?:but|however|although|yet)\b[^\r\n.!?]*\b(?:please\s+)?(?:add|address|change|ensure|fix|implement|prevent|reject|remove|restore|update|validate)\b/i;
const CLEAN_ATTESTATION_INLINE_FINDING =
  /(?:\b(?:filed|left|posted|created|added|reported)\s+(?:an?\s+|\d+\s+)?inline\s+(?:comments?|findings?)\b|\binline\s+(?:comments?|findings?)\s*:\s*(?!0\b|none\b|no\b)|\b(?:an?|\d+)\s+inline\s+(?:comments?|findings?)\s+(?:(?:was|were)\s+)?(?:exists?|remains?|filed|left|posted|created|added|reported)\b|\bthere\s+(?:is|are)\s+(?:an?|\d+)\s+inline\s+(?:comments?|findings?)\b|\binline\s+(?:comments?|findings?)\s+(?:(?:is|are)\s+)?(?:remain(?:s)?\s+)?(?:open|unresolved|outstanding|actionable)\b)/i;
const CLEAN_ATTESTATION_SECONDARY_VERDICT =
  /(?:^|[\r\n])\s*(?:[-*>]\s*)?Verdict\s*:/i;
const CLEAN_ATTESTATION_BUGBOT_MARKER = /\bBUGBOT_BUG_ID\b/;
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

function lineIsInsideMarkdownFence(lines, lineIndex) {
  let fence = null;
  for (let index = 0; index < lineIndex; index += 1) {
    const match = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    if (fence === null) {
      fence = { character: marker[0], length: marker.length };
      continue;
    }
    if (
      marker[0] === fence.character &&
      marker.length >= fence.length &&
      match[2].trim() === ""
    ) {
      fence = null;
    }
  }
  return fence !== null;
}

function startsMarkdownBlock(line) {
  return (
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}(?:>|1[.)][ \t]+\S|[-+*][ \t]+\S)/.test(line) ||
    /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line) ||
    /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) ||
    /^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t\n/>]|$)|<\/?(?:pre|script|style|textarea)(?:[ \t\n/>]|$))/i.test(
      line,
    )
  );
}

function markdownCodeSpanCandidates(lines) {
  const spans = [];
  let runs = [];
  let fence = null;
  let offset = 0;

  const closeInlineContainer = () => {
    for (let opener = 0; opener < runs.length; opener += 1) {
      const closer = runs.findIndex(
        (run, index) => index > opener && run.length === runs[opener].length,
      );
      if (closer < 0) continue;
      spans.push({
        openStart: runs[opener].start,
        contentStart: runs[opener].end,
        contentEnd: runs[closer].start,
        closeEnd: runs[closer].end,
      });
      opener = closer;
    }
    runs = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      closeInlineContainer();
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      offset += line.length + 1;
      continue;
    }

    if (fence !== null) {
      offset += line.length + 1;
      continue;
    }

    const containerBoundary = !line.trim() || startsMarkdownBlock(line);
    if (containerBoundary) closeInlineContainer();

    if (fence === null) {
      for (const match of line.matchAll(/`+/g)) {
        const start = match.index ?? 0;
        let backslashes = 0;
        for (
          let cursor = start - 1;
          cursor >= 0 && line[cursor] === "\\";
          cursor -= 1
        )
          backslashes += 1;
        if (backslashes % 2 === 0) {
          runs.push({
            start: offset + start,
            end: offset + start + match[0].length,
            length: match[0].length,
          });
        }
      }
    }
    if (containerBoundary) closeInlineContainer();
    offset += line.length + 1;
  }
  closeInlineContainer();
  return spans;
}

function markdownCodeSpans(lines) {
  const candidates = markdownCodeSpanCandidates(lines);
  const accepted = [];
  let candidateIndex = 0;
  let insideComment = false;
  let insideCodeUntil = -1;
  let fence = null;
  let offset = 0;

  for (const line of lines) {
    const lineEnd = offset + line.length;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!insideComment && insideCodeUntil <= offset && fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      offset = lineEnd + 1;
      continue;
    }
    if (!insideComment && insideCodeUntil <= offset && fence !== null) {
      offset = lineEnd + 1;
      continue;
    }

    let cursor = Math.max(offset, insideCodeUntil);
    while (cursor < lineEnd) {
      if (insideComment) {
        const close = line.indexOf("-->", cursor - offset);
        if (close < 0) break;
        insideComment = false;
        cursor = offset + close + 3;
        continue;
      }

      while (
        candidateIndex < candidates.length &&
        candidates[candidateIndex].openStart < cursor
      )
        candidateIndex += 1;
      const code =
        candidates[candidateIndex]?.openStart < lineEnd
          ? candidates[candidateIndex]
          : null;
      const open = line.indexOf("<!--", cursor - offset);
      const commentStart = open < 0 ? Number.POSITIVE_INFINITY : offset + open;
      if (code && code.openStart <= commentStart) {
        accepted.push(code);
        candidateIndex += 1;
        insideCodeUntil = code.closeEnd;
        cursor = code.closeEnd;
        continue;
      }
      if (commentStart < Number.POSITIVE_INFINITY) {
        insideComment = true;
        cursor = commentStart + 4;
        continue;
      }
      break;
    }
    offset = lineEnd + 1;
  }
  return accepted;
}

function lineIsInsideMarkdownCodeSpan(lines, lineIndex) {
  const targetStart = lines
    .slice(0, lineIndex)
    .reduce((total, line) => total + line.length + 1, 0);
  const targetEnd = targetStart + (lines[lineIndex]?.length ?? 0);
  return markdownCodeSpans(lines).some(
    (span) => span.contentStart <= targetStart && span.contentEnd >= targetEnd,
  );
}

function lineIsInsideHtmlComment(lines, lineIndex) {
  const codeSpans = markdownCodeSpans(lines);
  let codeIndex = 0;
  let insideComment = false;
  let fence = null;
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    const line = lines[index];
    const lineEnd = offset + line.length;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!insideComment && fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      offset = lineEnd + 1;
      continue;
    }
    if (fence !== null) {
      offset = lineEnd + 1;
      continue;
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (insideComment) {
        const close = line.indexOf("-->", cursor);
        if (close < 0) break;
        insideComment = false;
        cursor = close + 3;
      } else {
        while (
          codeIndex < codeSpans.length &&
          codeSpans[codeIndex].closeEnd <= offset + cursor
        )
          codeIndex += 1;
        const code = codeSpans[codeIndex];
        if (
          code &&
          code.openStart <= offset + cursor &&
          code.closeEnd > offset + cursor
        ) {
          cursor = Math.min(line.length, code.closeEnd - offset);
          continue;
        }

        const open = line.indexOf("<!--", cursor);
        if (open < 0) break;
        if (
          code &&
          code.openStart <= offset + open &&
          code.closeEnd > offset + open
        ) {
          cursor = Math.min(line.length, code.closeEnd - offset);
          continue;
        }
        insideComment = true;
        cursor = open + 4;
      }
    }
    offset = lineEnd + 1;
  }
  return insideComment;
}

function lineIsInsideMarkdownQuote(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) return false;
    if (/^ {0,3}>/.test(line)) return true;
  }
  return false;
}

function lineIsInsideExampleContext(lines, lineIndex) {
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^<\/details>\s*$/i.test(line)) return false;
    if (/<summary>\s*[^<]*\bexample\b/i.test(line)) return true;
    if (/^#{1,6}\s+/.test(line)) return /\bexample\b/i.test(line);
    if (/^(?:for\s+)?example\b[^.!?]*:\s*$/i.test(line)) return true;
  }
  return false;
}

function normalizeAttestationSignals(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(^|[\s([{])_{1,2}(?=\S)/g, "$1")
    .replace(/(\S)_{1,2}(?=$|[\s)\]},.!?;:])/g, "$1")
    .replace(/[`*~]/g, "");
}

function isExplicitlyCleanClaudeReviewAttestation(comment, pr) {
  const author = String(comment?.author ?? "").toLowerCase();
  if (author !== "claude" && author !== "claude[bot]") return false;

  const body = String(comment?.body ?? "");
  if (body.toLowerCase().split("mento-claude-review").length !== 2)
    return false;

  const lines = body.split(/\r?\n/);
  const exactMarkers = lines.flatMap((line, index) => {
    const marker = line.match(CLEAN_ATTESTATION_MARKER);
    return marker ? [{ index, marker }] : [];
  });
  if (exactMarkers.length !== 1) return false;

  const [{ index: markerIndex, marker }] = exactMarkers;
  const rollupIndex = markerIndex - 4;
  const lastNonemptyLine = lines.findLastIndex((line) => line.length > 0);
  if (
    markerIndex !== lastNonemptyLine ||
    lineIsInsideMarkdownFence(lines, markerIndex) ||
    lineIsInsideHtmlComment(lines, markerIndex) ||
    lineIsInsideHtmlComment(lines, rollupIndex) ||
    marker[1] !== String(pr?.number ?? "") ||
    marker[2] !== String(pr?.headRefOid ?? "")
  )
    return false;

  if (
    markerIndex < 4 ||
    lines[markerIndex - 4] !== CLEAN_ATTESTATION_ROLLUP ||
    lines[markerIndex - 3] !== "" ||
    lines[markerIndex - 2] !== CLEAN_ATTESTATION_NO_FINDINGS ||
    lines[markerIndex - 1] !== ""
  )
    return false;

  const verdictCandidates = lines.flatMap((line, index) =>
    CLEAN_ATTESTATION_VERDICT_CANDIDATE.test(line) ? [{ index, line }] : [],
  );
  const verdictIndex = verdictCandidates[0]?.index ?? -1;
  if (
    verdictCandidates.length !== 1 ||
    verdictCandidates[0].line !== CLEAN_ATTESTATION_VERDICT ||
    verdictIndex >= rollupIndex ||
    lineIsInsideMarkdownFence(lines, verdictIndex) ||
    lineIsInsideMarkdownCodeSpan(lines, verdictIndex) ||
    lineIsInsideMarkdownQuote(lines, verdictIndex) ||
    lineIsInsideHtmlComment(lines, verdictIndex) ||
    lineIsInsideExampleContext(lines, verdictIndex)
  )
    return false;

  const attestedReview = lines.slice(0, markerIndex).join("\n");
  const contradictionReview = normalizeAttestationSignals(attestedReview)
    .replace(CLEAN_ATTESTATION_CLEAN_NEGATION, "\n")
    .replace(/(?:^|[\r\n])\s*[,;:.!?]\s*/g, "\n");
  return !(
    CLEAN_ATTESTATION_PRIORITY_TAG.test(contradictionReview) ||
    CLEAN_ATTESTATION_SEVERITY.test(contradictionReview) ||
    CLEAN_ATTESTATION_NON_CLEAN_VERDICT.test(contradictionReview) ||
    CLEAN_ATTESTATION_ACTION_REQUEST.test(contradictionReview) ||
    CLEAN_ATTESTATION_DIRECTIVE.test(contradictionReview) ||
    CLEAN_ATTESTATION_MODAL_ACTION.test(contradictionReview) ||
    CLEAN_ATTESTATION_CONTRAST_ACTION.test(contradictionReview) ||
    CLEAN_ATTESTATION_INLINE_FINDING.test(contradictionReview) ||
    CLEAN_ATTESTATION_SECONDARY_VERDICT.test(contradictionReview) ||
    CLEAN_ATTESTATION_BUGBOT_MARKER.test(contradictionReview)
  );
}

export function classifyClaudeReviewAttestation(comment, pr) {
  const body = String(comment?.body ?? "");
  if (!CLEAN_ATTESTATION_NAMESPACE_CANDIDATE.test(body)) return null;
  return !isExplicitlyCleanClaudeReviewAttestation(comment, pr);
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
