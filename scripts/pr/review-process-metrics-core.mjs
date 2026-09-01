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

const FINDING_LABEL_SOURCE = String.raw`(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b|\b(?:critical|high|medium|low)\s+severity\b|\bchanges requested\b)`;
const FINDING_LABEL_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:and|or|nor)\b|[/,&]|\b(?:and|or|nor)\b)`;
const FINDING_LABEL_LIST_SOURCE = String.raw`${FINDING_LABEL_SOURCE}(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*${FINDING_LABEL_SOURCE})*`;
const COMPRESSED_SEVERITY_LABEL_LIST_SOURCE = String.raw`\b(?:critical|high|medium|low)\b(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*\b(?:critical|high|medium|low)\b)*\s+severity\b`;
const COMPRESSED_PRIORITY_BADGE_LABEL_LIST_SOURCE = String.raw`\b[Pp][0-3]\b(?:\s*${FINDING_LABEL_SEPARATOR_SOURCE}\s*\b[Pp][0-3]\b)*\s+Badge\b`;
const FINDING_LABEL_GROUP_SOURCE = String.raw`(?:${FINDING_LABEL_LIST_SOURCE}|${COMPRESSED_SEVERITY_LABEL_LIST_SOURCE}|${COMPRESSED_PRIORITY_BADGE_LABEL_LIST_SOURCE})`;
const EMPTY_FINDING_NOUN_SOURCE = String.raw`(?:findings?|issues?|defects?|problems?|concerns?|errors?)`;
const NEGATED_FINDING_NOUN_SOURCE = String.raw`(?:findings?|issues?|defects?|problems?|concerns?)`;
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
const EMPTY_FINDING_ENTRY_SEPARATOR = new RegExp(
  EMPTY_FINDING_ENTRY_SEPARATOR_SOURCE,
  "iy",
);
const NEGATED_COPULA_PREFIX = /\b(?:none|neither)\s+(?:are|is|was|were)\s*$/i;
const NEGATED_FINDING_SUBJECT_PREFIX =
  /\b(?:no\s+(?:findings?|issues?|defects?|problems?|concerns?)|none\s+of\s+(?:the\s+)?(?:findings?|issues?|defects?|problems?|concerns?)|neither\s+(?:finding|issue|defect|problem|concern)s?)\s+(?:are|is|was|were|has|have|had)(?:\s+(?:of|rated|classified\s+as|marked|labelled|labeled|considered(?:\s+to\s+be)?))?\s*$/i;
const NEGATED_REVIEW_RESULT_PREFIX =
  /^(?:(?:[-+•>]|#{1,6})\s+)*(?:(?:overall|in\s+summary|in\s+this\s+review|after\s+(?:the\s+)?review)\s*,\s*)?(?:(?:(?:i|we)|the\s+(?:review|report|scan|analysis|reviewer|bot|model))\s+(?:(?:(?:did|do|does|has|have|had|could|would|should|ca)n['’]t|(?:did|do|does|has|have|had|could|would|should|can)\s+not|cannot|never)\s+(?:find|found|report|reported|identify|identified|detect|detected|flag|flagged|show|shown|contain|contained)(?:\s+(?:any(?:\s+of\s+the)?|a|an|the\s+following\s+(?:findings?|issues?)(?:\s+claimed\s+by\s+the\s+analyzer)?\s*:))?)|(?:didn['’]t|never)\s+(?:find|found|identify|identified|detect|detected|flag|flagged)(?:\s+(?:any(?:\s+of\s+the)?|a|an))?|there\s+(?:is|are|was|were)(?:n['’]t|\s+not)(?:\s+(?:any|a|an))?)$/i;
const NEGATED_COPULAR_CLASSIFICATION_PREFIX =
  /^(?:this|that|it|the\s+(?:issues?|findings?|defects?|problems?|changes?))\s+(?:(?:is|are|was|were)\s+not|(?:is|are|was|were)n['’]t)(?:\s+(?:a|an))?$/i;
const NEGATED_FINDING_SUFFIX = new RegExp(
  String.raw`^\s*(?:${NEGATED_FINDING_NOUN_SOURCE})?${EMPTY_FINDING_ABSENCE_TAIL_SOURCE}(?:\s+at\s+all)?(?:\s+in\s+(?:this|the)\s+(?:review|report|scan|analysis|release|change|pull\s+request|PR))?\s*[,—–-]?\s*$`,
  "i",
);
const EMPTY_FINDING_TABLE_CELL = new RegExp(
  String.raw`^(?:(?:${ZERO_COUNT_SOURCE}|zero|none)(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?|no\s+${EMPTY_FINDING_NOUN_SOURCE})$`,
  "i",
);
const FINDING_TABLE_COUNT_CELL = new RegExp(
  String.raw`^(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine)(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?$`,
  "i",
);
const FINDING_TABLE_LABEL_CELL = new RegExp(
  String.raw`^${FINDING_LABEL_GROUP_SOURCE}(?:\s+findings?)?$`,
  "i",
);
const FINDING_ENTRY_START = new RegExp(
  String.raw`^(?:${FINDING_LABEL_GROUP_SOURCE}|${EMPTY_FINDING_PREFIX_LEAD_SOURCE}(?:(?::|[—–-])\s*)?${FINDING_LABEL_GROUP_SOURCE}|\(\s*${EMPTY_FINDING_PREFIX_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?\s*\)\s*${FINDING_LABEL_GROUP_SOURCE}|(?:\b\d+(?:\.\d+)?\b|\b(?:a|an|one|two|three|four|five|six|seven|eight|nine)\b)\s+${FINDING_LABEL_GROUP_SOURCE})`,
  "i",
);
const EMPTY_FINDING_INTRO_PREFIX =
  /^(?:(?:[-+•>]|#{1,6})\s+)*(?:there\s+(?:are|is|was|were)|(?:i|we|the\s+(?:review|report|scan|analysis))\s+(?:found|finds|reported|reports|contains?|has|have)|this\s+(?:contains?|has|reports?)|(?:review\s+(?:summary|results)|finding\s+counts|summary|counts|findings?|results?|review|report)\s*:)\s*$/i;
const EMPTY_FINDING_TRAILING_CLAUSE = new RegExp(
  String.raw`^(?:(?:no|zero|none)\s+${EMPTY_FINDING_NOUN_SOURCE}(?:\s+(?:remains?|exists?|found|reported|identified|detected|flagged|shown|(?:are|is|was|were)\s+(?:found|reported|identified|detected|flagged|shown|present)))?|no\s+action\s+(?:is\s+)?required)\s*$`,
  "i",
);

function normalizeFindingSummary(value) {
  return String(value ?? "")
    .replace(new RegExp(String.raw`\`(${FINDING_LABEL_SOURCE})\``, "gi"), "$1")
    .replace(/[*_~]/g, "");
}

function isEmptyFindingSummary(value) {
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

function isNegatedFindingPrefix(value, suffix) {
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
      FINDING_TABLE_LABEL_CELL.test(cells[index]) &&
      FINDING_TABLE_COUNT_CELL.test(cells[index + 1] ?? "")
    ) {
      index += 2;
      continue;
    }
    if (
      FINDING_TABLE_COUNT_CELL.test(cells[index]) &&
      FINDING_TABLE_LABEL_CELL.test(cells[index + 1] ?? "")
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
  const normalizedOccurrence =
    normalizeFindingSummary(occurrence).toLowerCase();
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
    if (!cell.toLowerCase().includes(normalizedOccurrence)) return false;
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
    /^\s*(?:,\s*(?:(?:and|or|nor)\b\s*)?|[\/&—–]\s*|-\s+|\b(?:and|or|nor)\b\s*)/i,
  );
  if (!separator) return false;
  const remainder = value.slice(separator[0].length).trim();
  return (
    !remainder ||
    FINDING_ENTRY_START.test(remainder) ||
    EMPTY_FINDING_TRAILING_CLAUSE.test(remainder)
  );
}

function isEmptyFindingOccurrence(prefix, occurrence, suffix) {
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

const FINDING_CLAUSE_BOUNDARY =
  /(?<!\d)\.|\.(?!\d)|[!?;\n]|\b(?:although|but|however|yet)\b/i;

function affirmativeOccurrence(body, pattern) {
  const text = String(body ?? "");
  const match = [...text.matchAll(pattern)].find((candidate) => {
    const matchIndex = candidate.index ?? 0;
    const matchEnd = matchIndex + candidate[0].length;
    const prefix =
      text.slice(0, matchIndex).split(FINDING_CLAUSE_BOUNDARY).at(-1) ?? "";
    const suffix = text.slice(matchEnd).split(FINDING_CLAUSE_BOUNDARY)[0] ?? "";
    return (
      !isNegatedFindingPrefix(prefix, suffix) &&
      !isEmptyFindingOccurrence(prefix, candidate[0], suffix)
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

function markdownTableCells(line) {
  if (!String(line ?? "").includes("|")) return null;
  const cells = String(line)
    .split("|")
    .map((cell) => normalizeFindingSummary(cell).trim());
  if (!cells[0]) cells.shift();
  if (!cells.at(-1)) cells.pop();
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(cells) {
  return Boolean(
    cells?.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
}

function findingLabelCellSignal(cell) {
  if (!FINDING_TABLE_LABEL_CELL.test(cell)) return null;
  return cell.match(new RegExp(FINDING_LABEL_SOURCE, "i"))?.[0] ?? null;
}

function findingTableCountValue(cell) {
  const normalized = normalizeFindingSummary(cell).trim();
  if (EMPTY_FINDING_TABLE_CELL.test(normalized)) return 0;
  if (!FINDING_TABLE_COUNT_CELL.test(normalized)) return null;
  return findingCountValue(normalized.split(/\s+/u)[0]);
}

function hasActionableFindingTableProse(row, proseColumns) {
  return proseColumns.some((column) => {
    const cell = normalizeFindingSummary(row[column] ?? "").trim();
    return Boolean(
      cell &&
      !EMPTY_FINDING_TABLE_CELL.test(cell) &&
      !/^(?:n\/?a|not\s+applicable|[-—–])$/i.test(cell),
    );
  });
}

function analyzeFindingTable(headerCells, rows) {
  const normalizedHeaders = headerCells.map((cell) =>
    cell.toLowerCase().replace(/\s+/gu, " ").trim(),
  );
  const proseColumns = normalizedHeaders.flatMap((header, index) =>
    /^(?:notes?|description|details?|message|summary)$/.test(header)
      ? [index]
      : [],
  );
  const categoryColumns = headerCells.flatMap((cell, index) =>
    findingLabelCellSignal(cell) === null ? [] : [index],
  );
  if (categoryColumns.length > 0) {
    for (const column of categoryColumns) {
      for (const row of rows) {
        const count = findingTableCountValue(row[column]);
        if (count === null) return { handled: false, signal: null };
        if (hasActionableFindingTableProse(row, proseColumns)) {
          return {
            handled: true,
            signal: findingLabelCellSignal(headerCells[column]),
          };
        }
        if (count !== 0) {
          return {
            handled: true,
            signal: findingLabelCellSignal(headerCells[column]),
          };
        }
      }
    }
    return { handled: true, signal: null };
  }

  const labelColumn = normalizedHeaders.findIndex((header) =>
    /^(?:severity|priority|badge|level)$/.test(header),
  );
  if (labelColumn < 0) return { handled: false, signal: null };
  const countColumn = normalizedHeaders.findIndex((header) =>
    /^(?:findings?|finding count|counts?|issues?|defects?|problems?|concerns?|errors?)$/.test(
      header,
    ),
  );
  let handled = false;
  for (const row of rows) {
    const signal = findingLabelCellSignal(row[labelColumn] ?? "");
    if (signal === null) continue;
    handled = true;
    if (countColumn < 0) return { handled: true, signal };
    const count = findingTableCountValue(row[countColumn] ?? "");
    if (count === null || count !== 0) return { handled: true, signal };
    if (hasActionableFindingTableProse(row, proseColumns)) {
      return { handled: true, signal };
    }
  }
  return { handled, signal: null };
}

function analyzeFindingTables(body) {
  const lines = String(body ?? "").split("\n");
  let signal = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = markdownTableCells(lines[index]);
    if (!headerCells) continue;
    let rowStart = index + 1;
    const possibleSeparator = markdownTableCells(lines[rowStart]);
    if (isMarkdownTableSeparator(possibleSeparator)) rowStart += 1;
    const rows = [];
    let rowEnd = rowStart;
    while (rowEnd < lines.length) {
      const cells = markdownTableCells(lines[rowEnd]);
      if (!cells || cells.length !== headerCells.length) break;
      rows.push(cells);
      rowEnd += 1;
    }
    if (rows.length === 0) continue;
    const analysis = analyzeFindingTable(headerCells, rows);
    if (!analysis.handled) continue;
    signal ??= analysis.signal;
    for (let lineIndex = index; lineIndex < rowEnd; lineIndex += 1) {
      lines[lineIndex] = "";
    }
    index = rowEnd - 1;
  }
  return { body: lines.join("\n"), signal };
}

const COUNT_NUMBER_SOURCE = String.raw`(?:\d+(?:\.\d+)?|no|none|a|an|zero|one|two|three|four|five|six|seven|eight|nine)`;
const COUNT_SERIES_SEPARATOR_SOURCE = String.raw`(?:,\s*(?:(?:and|or|nor)\s*)?|[/&—–-]\s*|\b(?:and|or|nor)\b\s*)`;
const SEVERITY_COUNT_ITEM_SOURCE = String.raw`${COUNT_NUMBER_SOURCE}\s+\b(?:critical|high|medium|low)\b(?:\s+severity)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`;
const PRIORITY_COUNT_ITEM_SOURCE = String.raw`${COUNT_NUMBER_SOURCE}\s+\b[Pp][0-3]\b(?:\s+Badge)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`;
const SEVERITY_COUNT_SERIES = new RegExp(
  String.raw`\b(?=[^.!?;\n]*\bseverity\b)${SEVERITY_COUNT_ITEM_SOURCE}(?:\s*${COUNT_SERIES_SEPARATOR_SOURCE}\s*${SEVERITY_COUNT_ITEM_SOURCE})+`,
  "gi",
);
const PRIORITY_COUNT_SERIES = new RegExp(
  String.raw`\b(?=[^.!?;\n]*\bBadge\b)${PRIORITY_COUNT_ITEM_SOURCE}(?:\s*${COUNT_SERIES_SEPARATOR_SOURCE}\s*${PRIORITY_COUNT_ITEM_SOURCE})+`,
  "gi",
);
const SEVERITY_COUNT_ITEM = new RegExp(
  String.raw`\b(${COUNT_NUMBER_SOURCE})\s+(critical|high|medium|low)\b(?:\s+severity)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`,
  "gi",
);
const PRIORITY_COUNT_ITEM = new RegExp(
  String.raw`\b(${COUNT_NUMBER_SOURCE})\s+([Pp][0-3])\b(?:\s+Badge)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`,
  "gi",
);

function firstNonzeroCountSeriesLabel(body, seriesPattern, itemPattern) {
  const text = String(body ?? "");
  for (const series of text.matchAll(seriesPattern)) {
    const prefix =
      text
        .slice(0, series.index ?? 0)
        .split(FINDING_CLAUSE_BOUNDARY)
        .at(-1) ?? "";
    if (
      NEGATED_REVIEW_RESULT_PREFIX.test(normalizeFindingSummary(prefix).trim())
    ) {
      continue;
    }
    for (const item of series[0].matchAll(itemPattern)) {
      if (findingCountValue(item[1]) !== 0) {
        return (
          item[0].match(
            /\b(?:critical|high|medium|low)\s+severity\b|\b[Pp][0-3]\s+Badge\b/i,
          )?.[0] ?? item[2]
        );
      }
    }
  }
  return null;
}

function findingCountValue(value) {
  const normalized = String(value ?? "").toLowerCase();
  const wordValues = {
    no: 0,
    none: 0,
    a: 1,
    an: 1,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  };
  return wordValues[normalized] ?? Number(normalized);
}

function affirmativeCompressedCountSignal(body) {
  return (
    firstNonzeroCountSeriesLabel(
      body,
      PRIORITY_COUNT_SERIES,
      PRIORITY_COUNT_ITEM,
    ) ??
    firstNonzeroCountSeriesLabel(
      body,
      SEVERITY_COUNT_SERIES,
      SEVERITY_COUNT_ITEM,
    )
  );
}

function withoutNegatedCountSeries(body) {
  let text = String(body ?? "");
  for (const pattern of [PRIORITY_COUNT_SERIES, SEVERITY_COUNT_SERIES]) {
    text = text.replace(pattern, (series, ...args) => {
      const offset = args.at(-2);
      const prefix =
        text.slice(0, offset).split(FINDING_CLAUSE_BOUNDARY).at(-1) ?? "";
      return NEGATED_REVIEW_RESULT_PREFIX.test(
        normalizeFindingSummary(prefix).trim(),
      )
        ? " ".repeat(series.length)
        : series;
    });
  }
  return text;
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
  const tableAnalysis = analyzeFindingTables(body);
  const proseBody = withoutNegatedCountSeries(tableAnalysis.body);
  return (
    tableAnalysis.signal ??
    affirmativeCompressedCountSignal(proseBody) ??
    affirmativePriority(proseBody) ??
    affirmativeSeverity(proseBody) ??
    affirmativeChangesRequested(proseBody)
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
