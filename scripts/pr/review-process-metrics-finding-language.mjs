const FINDING_LABEL_SOURCE = String.raw`(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b|\b(?:critical|high|medium|low)\s+severity\b|\bchanges\s+requested\b)`;
export const FINDING_LABEL = new RegExp(FINDING_LABEL_SOURCE, "i");
export const FINDING_HINT = /\b(?:p[0-3]|critical|high|medium|low|changes)\b/i;
const FINDING_LABEL_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:and|or|nor)\b|[/,&]|\b(?:and|or|nor)\b)`;
const FINDING_LABEL_LIST_SOURCE = String.raw`${FINDING_LABEL_SOURCE}(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*${FINDING_LABEL_SOURCE})*`;
const COMPRESSED_SEVERITY_LABEL_LIST_SOURCE = String.raw`\b(?:critical|high|medium|low)\b(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*\b(?:critical|high|medium|low)\b)*\s+severity\b`;
const COMPRESSED_PRIORITY_BADGE_LABEL_LIST_SOURCE = String.raw`\b[Pp][0-3]\b(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*\b[Pp][0-3]\b)*\s+Badge\b`;
const FINDING_LABEL_GROUP_SOURCE = String.raw`(?:${FINDING_LABEL_LIST_SOURCE}|${COMPRESSED_SEVERITY_LABEL_LIST_SOURCE}|${COMPRESSED_PRIORITY_BADGE_LABEL_LIST_SOURCE})`;
export const EMPTY_FINDING_NOUN_SOURCE = String.raw`(?:findings?|issues?|defects?|problems?|concerns?|errors?)`;
export const NEGATED_FINDING_NOUN_SOURCE = String.raw`(?:findings?|issues?|defects?|problems?|concerns?)`;
const EMPTY_FINDING_ABSENCE_TAIL_SOURCE = String.raw`(?:\s+(?:remains?|exists?|(?:are|is|was|were)\s+(?:found|reported|identified|detected|flagged|shown|present)))?`;
const ZERO_COUNT_SOURCE = String.raw`\b0(?:\.0+)?\b`;
const EMPTY_FINDING_PREFIX_SOURCE = String.raw`(?:${ZERO_COUNT_SOURCE}|\bzero\b|\bnone\b|\bno\b|\bneither\b)`;
const EMPTY_FINDING_SUFFIX_SOURCE = String.raw`(?:${ZERO_COUNT_SOURCE}|\bzero\b|\bnone\b|\bno\s+${EMPTY_FINDING_NOUN_SOURCE}\b)`;
const EMPTY_FINDING_PREFIX_LEAD_SOURCE = String.raw`${EMPTY_FINDING_PREFIX_SOURCE}\s*(?:(?:additional|new|remaining|unresolved)\s+)?(?:${EMPTY_FINDING_NOUN_SOURCE}\s+)?(?:of\s+(?:the\s+)?)?(?:(?:rated|classified|marked|labelled|labeled)(?:\s+as)?\s+)?`;
const EMPTY_FINDING_PREFIX_ENTRY_SOURCE = String.raw`(?:(?:\btotal\s*:\s*)?${EMPTY_FINDING_PREFIX_LEAD_SOURCE}(?:(?::|[—–-])\s*)?${FINDING_LABEL_GROUP_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?${EMPTY_FINDING_ABSENCE_TAIL_SOURCE}|\(\s*${EMPTY_FINDING_PREFIX_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?\s*\)\s*${FINDING_LABEL_GROUP_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?${EMPTY_FINDING_ABSENCE_TAIL_SOURCE})`;
const EMPTY_FINDING_SUFFIX_ENTRY_SOURCE = String.raw`${FINDING_LABEL_GROUP_SOURCE}\s*(?:${EMPTY_FINDING_NOUN_SOURCE}\s*)?(?:(?:(?:(?:count|total)\s*)?(?::|[—–=\-])\s*|(?:totaled|totals?)\s+)${EMPTY_FINDING_SUFFIX_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?${EMPTY_FINDING_ABSENCE_TAIL_SOURCE}|\(\s*${EMPTY_FINDING_SUFFIX_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?\s*\)${EMPTY_FINDING_ABSENCE_TAIL_SOURCE})`;
const EMPTY_FINDING_ENTRY_SOURCE = String.raw`(?:${EMPTY_FINDING_PREFIX_ENTRY_SOURCE}|${EMPTY_FINDING_SUFFIX_ENTRY_SOURCE})`;
const EMPTY_FINDING_ENTRY_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:and|or|nor)\b|[—–,/&\-]|\b(?:and|or|nor)\b)`;
const EMPTY_FINDING_ENTRY = new RegExp(EMPTY_FINDING_ENTRY_SOURCE, "iy");
// prettier-ignore
const EMPTY_FINDING_ENTRY_SEPARATOR = new RegExp(EMPTY_FINDING_ENTRY_SEPARATOR_SOURCE, "iy");
const NEGATED_COPULA_PREFIX = /\b(?:none|neither)\s+(?:are|is|was|were)\s*$/i;
const NEGATED_FINDING_SUBJECT_PREFIX =
  /\b(?:no\s+(?:findings?|issues?|defects?|problems?|concerns?)|none\s+of\s+(?:the\s+)?(?:findings?|issues?|defects?|problems?|concerns?)|neither\s+(?:finding|issue|defect|problem|concern)s?)\s+(?:are|is|was|were|has|have|had)(?:\s+(?:of|rated|classified\s+as|marked|labelled|labeled|considered(?:\s+to\s+be)?))?\s*$/i;
export const NEGATED_REVIEW_RESULT_PREFIX =
  /^(?:(?:[-+•>]|#{1,6})\s+)*(?:(?:overall|in\s+summary|in\s+this\s+review|after\s+(?:the\s+)?review)\s*,\s*)?(?:(?:(?:i|we)|the\s+(?:review|report|scan|analysis|reviewer|bot|model))\s+(?:(?:(?:did|do|does|has|have|had|could|would|should|ca)n['’]t|(?:did|do|does|has|have|had|could|would|should|can)\s+not|cannot|never)\s+(?:find|found|report|reported|identify|identified|detect|detected|flag|flagged|show|shown|contain|contained)(?:\s+(?:any(?:\s+of\s+the)?|a|an|the\s+following\s+(?:findings?|issues?)(?:\s+claimed\s+by\s+the\s+analyzer)?\s*:))?)|(?:didn['’]t|never)\s+(?:find|found|identify|identified|detect|detected|flag|flagged)(?:\s+(?:any(?:\s+of\s+the)?|a|an))?|there\s+(?:is|are|was|were)(?:n['’]t|\s+not)(?:\s+(?:any|a|an))?)$/i;
const NEGATED_COPULAR_CLASSIFICATION_PREFIX =
  /^(?:this|that|it|the\s+(?:issues?|findings?|defects?|problems?|changes?))\s+(?:(?:is|are|was|were)\s+not|(?:is|are|was|were)n['’]t)(?:\s+(?:a|an))?$/i;
// prettier-ignore
const NEGATED_FINDING_SUFFIX = new RegExp(String.raw`^\s*(?:${NEGATED_FINDING_NOUN_SOURCE})?${EMPTY_FINDING_ABSENCE_TAIL_SOURCE}(?:\s+at\s+all)?(?:\s+in\s+(?:this|the)\s+(?:review|report|scan|analysis|release|change|pull\s+request|PR))?\s*[,—–-]?\s*$`, "i");
// prettier-ignore
export const EMPTY_FINDING_TABLE_CELL = new RegExp(String.raw`^(?:(?:${ZERO_COUNT_SOURCE}|zero|none)(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?|no\s+${EMPTY_FINDING_NOUN_SOURCE})$`, "i");
const FINDING_TABLE_COUNT_CELL = new RegExp(
  String.raw`^(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine)(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?$`,
  "i",
);
export const FINDING_TABLE_LABEL_CELL = new RegExp(
  String.raw`^${FINDING_LABEL_GROUP_SOURCE}(?:\s+findings?)?$`,
  "i",
);
const FINDING_ENTRY_START = new RegExp(
  String.raw`^(?:${FINDING_LABEL_GROUP_SOURCE}|${EMPTY_FINDING_PREFIX_LEAD_SOURCE}(?:(?::|[—–-])\s*)?${FINDING_LABEL_GROUP_SOURCE}|\(\s*${EMPTY_FINDING_PREFIX_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?\s*\)\s*${FINDING_LABEL_GROUP_SOURCE}|(?:\b\d+(?:\.\d+)?\b|\b(?:a|an|one|two|three|four|five|six|seven|eight|nine)\b)\s+${FINDING_LABEL_GROUP_SOURCE})`,
  "i",
);
const EMPTY_FINDING_INTRO_PREFIX =
  /^(?:(?:[-+•>]|#{1,6})\s+)*(?:there\s+(?:are|is|was|were)|(?:i|we|the\s+(?:review|report|scan|analysis))\s+(?:found|finds|reported|reports|contains?|has|have)|this\s+(?:contains?|has|reports?)|(?:review\s+(?:summary|results)|finding\s+counts|summary|counts|findings?|results?|review|report)\s*:)\s*$/i;
const EMPTY_FINDING_SCOPE_SOURCE = String.raw`(?:\s+in\s+(?:(?:this|the)\s+)?(?:changed\s+)?(?:code|changes?|review|pull\s+request|PR))?`;
export const EMPTY_FINDING_TRAILING_CLAUSE = new RegExp(
  String.raw`^(?:(?:(?:no|zero)\s+${EMPTY_FINDING_NOUN_SOURCE}|none|nothing)(?:\s+(?:remains?|exists?|found|reported|identified|detected|flagged|shown|(?:are|is|was|were)\s+(?:found|reported|identified|detected|flagged|shown|present)))?${EMPTY_FINDING_SCOPE_SOURCE}|no\s+action\s+(?:is\s+)?(?:required|needed))\s*$`,
  "i",
);
export function normalizeFindingSummary(value) {
  return String(value ?? "")
    .replace(new RegExp(String.raw`\`(${FINDING_LABEL_SOURCE})\``, "gi"), "$1")
    .replace(/[*_~]/g, "")
    .replace(/[ \t]+/g, " ");
}
export function isEmptyFindingSummary(value) {
  const normalized = normalizeFindingSummary(value)
    .trim()
    .replace(/^(?:(?:[-+•>]|#{1,6})\s+)*/, "");
  if (!normalized) return false;
  let cursor = 0;
  while (cursor < normalized.length) {
    EMPTY_FINDING_ENTRY.lastIndex = cursor;
    const entry = EMPTY_FINDING_ENTRY.exec(normalized);
    if (!entry || entry.index !== cursor) return false;
    cursor = EMPTY_FINDING_ENTRY.lastIndex;
    while (/\s/u.test(normalized[cursor] ?? "")) cursor += 1;
    if (cursor === normalized.length) return true;
    if (normalized[cursor] === "," && !normalized.slice(cursor + 1).trim()) {
      return true;
    }
    EMPTY_FINDING_ENTRY_SEPARATOR.lastIndex = cursor;
    const separator = EMPTY_FINDING_ENTRY_SEPARATOR.exec(normalized);
    if (!separator || separator.index !== cursor) return false;
    cursor = EMPTY_FINDING_ENTRY_SEPARATOR.lastIndex;
    while (/\s/u.test(normalized[cursor] ?? "")) cursor += 1;
  }
  return false;
}
export function isNegatedFindingPrefix(value, suffix) {
  const normalized = normalizeFindingSummary(value).trim();
  return Boolean(
    (NEGATED_COPULA_PREFIX.test(normalized) ||
      NEGATED_FINDING_SUBJECT_PREFIX.test(normalized) ||
      NEGATED_REVIEW_RESULT_PREFIX.test(normalized) ||
      NEGATED_COPULAR_CLASSIFICATION_PREFIX.test(normalized)) &&
    NEGATED_FINDING_SUFFIX.test(normalizeFindingSummary(suffix)),
  );
}
function isValidFindingTableTail(cells, startIndex) {
  let index = startIndex;
  while (index < cells.length) {
    if (
      EMPTY_FINDING_TABLE_CELL.test(cells[index]) ||
      isEmptyFindingSummary(cells[index])
    ) {
      index += 1;
      continue;
    }
    if (
      (FINDING_TABLE_LABEL_CELL.test(cells[index]) &&
        FINDING_TABLE_COUNT_CELL.test(cells[index + 1] ?? "")) ||
      (FINDING_TABLE_COUNT_CELL.test(cells[index]) &&
        FINDING_TABLE_LABEL_CELL.test(cells[index + 1] ?? ""))
    ) {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}
function isEmptyFindingTableRow(value, occurrence) {
  const normalized = normalizeFindingSummary(value).trim();
  if (!normalized.includes("|")) return false;
  const cells = normalized
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  const needle = normalizeFindingSummary(occurrence).toLowerCase();
  const prefixCountPairs =
    cells.length % 2 === 0 &&
    cells.every((cell, index) =>
      index % 2 === 0
        ? FINDING_TABLE_COUNT_CELL.test(cell) ||
          EMPTY_FINDING_TABLE_CELL.test(cell)
        : FINDING_TABLE_LABEL_CELL.test(cell),
    );
  const suffixCountPairs =
    cells.length % 2 === 0 &&
    cells.every((cell, index) =>
      index % 2 === 0
        ? FINDING_TABLE_LABEL_CELL.test(cell)
        : FINDING_TABLE_COUNT_CELL.test(cell) ||
          EMPTY_FINDING_TABLE_CELL.test(cell),
    );
  return cells.some((cell, occurrenceCellIndex) => {
    if (!cell.toLowerCase().includes(needle)) return false;
    if (prefixCountPairs && occurrenceCellIndex % 2 === 1) {
      return EMPTY_FINDING_TABLE_CELL.test(cells[occurrenceCellIndex - 1]);
    }
    if (suffixCountPairs && occurrenceCellIndex % 2 === 0) {
      return EMPTY_FINDING_TABLE_CELL.test(cells[occurrenceCellIndex + 1]);
    }
    if (isEmptyFindingSummary(cell)) {
      return isValidFindingTableTail(cells, occurrenceCellIndex + 1);
    }
    if (!FINDING_TABLE_LABEL_CELL.test(cell)) return false;
    const nextCell = cells[occurrenceCellIndex + 1] ?? "";
    if (
      FINDING_TABLE_COUNT_CELL.test(nextCell) ||
      EMPTY_FINDING_TABLE_CELL.test(nextCell)
    ) {
      return (
        EMPTY_FINDING_TABLE_CELL.test(nextCell) &&
        isValidFindingTableTail(cells, occurrenceCellIndex + 2)
      );
    }
    return (
      EMPTY_FINDING_TABLE_CELL.test(cells[occurrenceCellIndex - 1] ?? "") &&
      isValidFindingTableTail(cells, occurrenceCellIndex + 1)
    );
  });
}
function hasEmptyEntryBoundaryBefore(value) {
  const trimmed = value.trimEnd();
  if (!trimmed || /^(?:(?:[-+•>]|#{1,6})\s*)+$/.test(trimmed)) return true;
  if (EMPTY_FINDING_INTRO_PREFIX.test(trimmed)) return true;
  return (
    /(?:[,/&—–]|\b(?:and|or|nor))\s*$/i.test(value) || /-\s+$/u.test(value)
  );
}
function hasEmptyEntryBoundaryAfter(value) {
  if (!value.trim()) return true;
  const separator = value.match(
    /^\s*(?:,\s*(?:(?:and|or|nor)\b\s*)?|[/&—–]\s*|-\s+|\b(?:and|or|nor)\b\s*)/i,
  );
  if (!separator) return false;
  const remainder = value.slice(separator[0].length).trim();
  return (
    !remainder ||
    FINDING_ENTRY_START.test(remainder) ||
    EMPTY_FINDING_TRAILING_CLAUSE.test(remainder)
  );
}
export function isEmptyFindingOccurrence(prefix, occurrence, suffix) {
  const normalizedPrefix = normalizeFindingSummary(prefix);
  const normalizedOccurrence = normalizeFindingSummary(occurrence);
  const normalizedSuffix = normalizeFindingSummary(suffix);
  const clause = `${normalizedPrefix}${normalizedOccurrence}${normalizedSuffix}`;
  if (isEmptyFindingTableRow(clause, normalizedOccurrence)) return true;
  if (isEmptyFindingSummary(clause)) return true;
  const occurrenceStart = normalizedPrefix.length;
  const occurrenceEnd = occurrenceStart + normalizedOccurrence.length;
  const matches = clause.matchAll(new RegExp(EMPTY_FINDING_ENTRY_SOURCE, "gi"));
  return [...matches].some((match) => {
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    return (
      matchStart <= occurrenceStart &&
      occurrenceEnd <= matchEnd &&
      hasEmptyEntryBoundaryBefore(clause.slice(0, matchStart)) &&
      hasEmptyEntryBoundaryAfter(clause.slice(matchEnd))
    );
  });
}
