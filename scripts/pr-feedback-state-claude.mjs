const COMMONMARK_ASCII_PUNCTUATION_ESCAPE =
  /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;

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
