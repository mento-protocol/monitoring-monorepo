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

const BRACKETED_PRIORITY_SOURCE = String.raw`\[[Pp][0-3]\]`;
const BRACKETED_PRIORITY_SEPARATOR_SOURCE = String.raw`(?:/|,\s*(?:(?:and|or|nor)\s*)?|\b(?:and|or|nor)\b)`;
const BRACKETED_PRIORITY_LIST_SOURCE = String.raw`${BRACKETED_PRIORITY_SOURCE}(?:\s*${BRACKETED_PRIORITY_SEPARATOR_SOURCE}\s*${BRACKETED_PRIORITY_SOURCE})*`;
const PRIORITY_CLAUSE_LEAD_SOURCE = String.raw`(^|[.!?;\n])\s*(?:(?:[-+•>]|#{1,6})\s+)*(?:\d+[.)]\s+)?`;
const REVIEW_DOMAIN_SOURCE = String.raw`(?:correctness|security|convention)`;
const REVIEW_DOMAIN_LIST_SOURCE = String.raw`${REVIEW_DOMAIN_SOURCE}(?:\s*,\s*${REVIEW_DOMAIN_SOURCE})*(?:\s*,?\s*(?:and|or)\s+${REVIEW_DOMAIN_SOURCE})?`;
const LABEL_FIRST_ABSENCE_SOURCE = String.raw`(?:none\b|no\s+${NEGATED_FINDING_NOUN_SOURCE}\b(?:\s+(?:remains?|exists?|found|reported|identified|detected|flagged|shown|present|(?:are|is|was|were)\s+(?:found|reported|identified|detected|flagged|shown|present)))?)`;
const NEGATED_PRIORITY_CLAUSES = [
  new RegExp(
    String.raw`${PRIORITY_CLAUSE_LEAD_SOURCE}no\s+inline\s+findings?\s*[—–-]\s*nothing\s+(?:rose|rises?)\s+to\s+${BRACKETED_PRIORITY_LIST_SOURCE}(?=\s*(?:[.!?;\n]|$))`,
    "gim",
  ),
  new RegExp(
    String.raw`${PRIORITY_CLAUSE_LEAD_SOURCE}no\s+inline\s+comments?\s+(?:are|is|was|were)\s+posted\s*[—–-]\s*(?:i|we)\s+(?:(?:did|do)\s+not|didn['’]t|don['’]t)\s+find\s+any(?:\s+concrete)?\s+${REVIEW_DOMAIN_LIST_SOURCE}\s+findings?\s+tied\s+to\s+(?:a|any)\s+specific\s+lines?\s+worth\s+flagging\s+at\s+${BRACKETED_PRIORITY_LIST_SOURCE}(?=\s*(?:[.!?;\n]|$))`,
    "gim",
  ),
  new RegExp(
    String.raw`${PRIORITY_CLAUSE_LEAD_SOURCE}none\s+at\s+${BRACKETED_PRIORITY_LIST_SOURCE}(?=\s*(?:[.!?;\n]|$))`,
    "gim",
  ),
  new RegExp(
    String.raw`${PRIORITY_CLAUSE_LEAD_SOURCE}${BRACKETED_PRIORITY_LIST_SOURCE}\s*(?:[:—–-]\s*)?${LABEL_FIRST_ABSENCE_SOURCE}(?=\s*(?:[.!?;\n]|[—–-]|$))`,
    "gim",
  ),
];

function withoutNegatedPriorityClauses(body) {
  return NEGATED_PRIORITY_CLAUSES.reduce(
    (text, pattern) =>
      text.replace(
        pattern,
        (match, boundary) =>
          `${boundary}${" ".repeat(match.length - boundary.length)}`,
      ),
    normalizeFindingSummary(body),
  );
}

export function actionableFindingSignal(
  value,
  bot,
  { reviewState = null } = {},
) {
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
  const proseBody = withoutNegatedPriorityClauses(
    withoutNegatedCountSeries(tableAnalysis.body),
  );
  return (
    tableAnalysis.signal ??
    affirmativeCompressedCountSignal(proseBody) ??
    affirmativePriority(proseBody) ??
    affirmativeSeverity(proseBody) ??
    affirmativeChangesRequested(proseBody)
  );
}
