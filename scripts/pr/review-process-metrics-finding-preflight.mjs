const FINDING_LABEL =
  /(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b|\b(?:critical|high|medium|low)\s+severity\b|\bchanges\s+requested\b)/gi;
const MAX_FINDING_LABELS = 256;
const MAX_FINDING_CONTEXT_LENGTH = 4_096;

function isDigit(value) {
  return value >= "0" && value <= "9";
}

function isOrderedListMarker(text, index) {
  if (!isDigit(text[index - 1]) || !/\s/u.test(text[index + 1] ?? "")) {
    return false;
  }
  let cursor = index - 1;
  while (isDigit(text[cursor])) cursor -= 1;
  while (text[cursor] === " " || text[cursor] === "\t") cursor -= 1;
  return cursor < 0 || text[cursor] === "\n";
}

function boundaryTailEnd(text, index) {
  let cursor = index + 1;
  while (cursor - index <= 16 && /[*_~`)\]}>'"’”]/u.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor === text.length || /\s/u.test(text[cursor] ?? "")
    ? cursor
    : null;
}

function isSentenceBoundary(text, index) {
  const value = text[index];
  if (value === "\n") return true;
  if (value !== "." && value !== "!" && value !== "?" && value !== ";") {
    return false;
  }
  if (boundaryTailEnd(text, index) === null) return false;
  if (value !== ".") return true;
  return (
    !(isDigit(text[index - 1]) && isDigit(text[index + 1])) &&
    !isOrderedListMarker(text, index)
  );
}

function findingContext(text, start, end) {
  let left = start;
  while (
    left > 0 &&
    start - left < MAX_FINDING_CONTEXT_LENGTH &&
    !isSentenceBoundary(text, left - 1)
  ) {
    left -= 1;
  }
  if (left > 0 && !isSentenceBoundary(text, left - 1)) {
    return null;
  }
  if (left > 0 && text[left - 1] !== "\n") {
    left = boundaryTailEnd(text, left - 1) ?? left;
  }

  const rightBudget = MAX_FINDING_CONTEXT_LENGTH - (end - left);
  if (rightBudget < 0) return null;
  let right = end;
  while (
    right < text.length &&
    right - end <= rightBudget &&
    !isSentenceBoundary(text, right)
  ) {
    right += 1;
  }
  if (right < text.length && !isSentenceBoundary(text, right)) {
    return null;
  }
  return { start: left, end: right };
}

function nextSentenceEnd(text, boundary) {
  if (boundary >= text.length) return boundary;
  let start = boundary + 1;
  while (
    start < text.length &&
    start - boundary <= MAX_FINDING_CONTEXT_LENGTH &&
    /[\s*_~`)\]}>'"’”]/u.test(text[start])
  ) {
    start += 1;
  }
  if (start >= text.length) return text.length;
  const limit = Math.min(text.length, start + MAX_FINDING_CONTEXT_LENGTH);
  let end = start;
  while (end < limit && !isSentenceBoundary(text, end)) end += 1;
  if (end < text.length && isSentenceBoundary(text, end)) end += 1;
  return end;
}

function maskFindingGap(value) {
  return String(value).replace(/[^.!?;\n]/gu, " ");
}

export function boundedFindingProse(value) {
  const text = String(value ?? "");
  let count = 0;
  const contexts = [];
  for (const match of text.matchAll(FINDING_LABEL)) {
    count += 1;
    if (count > MAX_FINDING_LABELS) {
      throw new Error(
        `finding candidate limit exceeded (maximum ${MAX_FINDING_LABELS})`,
      );
    }
    const start = match.index ?? 0;
    const context = findingContext(text, start, start + match[0].length);
    if (context === null) {
      throw new Error(
        `finding context limit exceeded (maximum ${MAX_FINDING_CONTEXT_LENGTH} characters)`,
      );
    }
    const previous = contexts.at(-1);
    if (previous?.start !== context.start || previous.end !== context.end) {
      contexts.push(context);
    }
  }
  let cursor = 0;
  let prose = "";
  for (const context of contexts) {
    const end = nextSentenceEnd(text, context.end);
    if (context.start < cursor) {
      if (end > cursor) prose += text.slice(cursor, end);
    } else {
      prose += maskFindingGap(text.slice(cursor, context.start));
      prose += text.slice(context.start, end);
    }
    cursor = Math.max(cursor, end);
  }
  return prose;
}

export function botSpecificFindingSignal(body, bot) {
  if (bot === "coderabbit") {
    return (
      body.match(/<!--\s*cr-indicator-types\s*:[^>]{1,120}-->/i)?.[0] ??
      body.match(
        /_\s*(?:\p{Extended_Pictographic}️?\s*)?(?:Critical|Major|Minor|Trivial)\s*_/u,
      )?.[0] ??
      null
    );
  }
  // prettier-ignore
  if (bot === "cursor") return body.match(/<!--\s*(BUGBOT_BUG_ID)\s*:(?=[^>\r\n]{0,119}\S\s*-->)[^>\r\n]{1,120}-->/i)?.[1] ?? null;
  // prettier-ignore
  return bot === "codex" ? body.match(/(?:^|\n)\*\*<sub><sub>!\[((P[0-3]) Badge)\]\(https:\/\/img\.shields\.io\/badge\/\2-(?:red|orange|yellow|blue)\?style=flat\)<\/sub><\/sub>[ \t]{1,3}\S[^\r\n]*?\*\*(?=\r?\n|$)/)?.[1] : undefined;
}
