import {
  isResolvedImageReferenceOnly,
  parseMarkdownEvidence,
} from "./review-process-metrics-markdown.mjs";
import {
  botSpecificFindingSignal,
  boundedFindingProse,
} from "./review-process-metrics-finding-preflight.mjs";
import {
  EMPTY_FINDING_NOUN_SOURCE,
  EMPTY_FINDING_TABLE_CELL,
  EMPTY_FINDING_TRAILING_CLAUSE,
  FINDING_HINT,
  FINDING_LABEL,
  FINDING_TABLE_LABEL_CELL,
  NEGATED_FINDING_NOUN_SOURCE,
  NEGATED_REVIEW_RESULT_PREFIX,
  isEmptyFindingOccurrence,
  isEmptyFindingSummary,
  isNegatedFindingPrefix,
  normalizeFindingSummary,
} from "./review-process-metrics-finding-language.mjs";
const FINDING_CLAUSE_BOUNDARY =
  /(?<!\d)\.|\.(?!\d)|[!?;\n]|\b(?:although|but|however|yet)\b/i;
const PRIORITY_CLAUSE_BOUNDARY =
  /(?<!\d)\.|\.(?!\d)|[!?;\n]|\b(?:although|but|however|yet)\b(?!\s+(?:(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b)|(?:only\s+)?(?:\d+(?:\.\d+)?|no|none|a|an|zero|one|two|three|four|five|six|seven|eight|nine)\s+(?:\[[Pp][0-3]\]|\b[Pp][0-3]\b(?:\s+Badge)?)|(?:(?:(?:it|this|that|the|these|those|they|both)(?:\s+(?:findings?|issues?|defects?|problems?|concerns?|errors?|observations?|comments?|items?|recommendations?|counts?|entries?|fixtures?|examples?|samples?|test\s+cases?))?\s+(?:is|are|was|were)\s+(?:(?:(?:only|just|merely|solely)\s+)?(?:used|included|shown)\s+(?:(?:only|just|merely|solely)\s+)?(?:as|in)\s+|(?:(?:only|just|merely|solely)\s+)?(?:covered|expected)\s+(?:(?:only|just|merely|solely)\s+)?by\s+|(?:(?:only|just|merely|solely)\s+)?)|(?:it|this|that|the|these|those|they|both)(?:\s+(?:findings?|observations?|comments?|items?|recommendations?|counts?|entries?|fixtures?|examples?|samples?|test\s+cases?))?\s+(?:(?:appears?|occurs?|exists?)\s+(?:(?:only|just|merely|solely)\s+in\s+|in\s+(?:only|just|merely|solely)\s+|in\s+(?=[^.!?;\n]*\b(?:only|just|merely|solely)\s*(?:[.!?;\n]|$)))|(?:only|just|merely|solely)\s+(?:appears?|occurs?|exists?)\s+in\s+)|(?:only|just|merely|solely)\s+as\s+)(?:(?:an?|the|this|that|these|those)\s+)?(?:(?:(?:parser|test|fixture|example|sample)\s+)*(?:fixtures?|examples?|samples?|tests?|test\s+cases?)|(?:(?:parser|test|fixture|example|sample)\s+)+data)\b(?:\s+(?:(?:used|included|shown)\s+in\s+(?:the\s+)?(?:tests?|fixtures?)|for\s+(?:(?:parser|test)\s+)?coverage))?(?:\s+(?:only|just|merely|solely))?(?=\s*(?:[.!?;\n]|$)))))/i;
function affirmativeOccurrence(body, pattern, isSupported = () => true) {
  const text = String(body ?? "");
  const priority = pattern === PRIORITY_SIGNAL;
  // prettier-ignore
  const boundary = priority ? PRIORITY_CLAUSE_BOUNDARY : FINDING_CLAUSE_BOUNDARY;
  for (const candidate of text.matchAll(pattern)) {
    const matchIndex = candidate.index ?? 0;
    const matchEnd = matchIndex + candidate[0].length;
    let prefix =
      text.slice(0, matchIndex).split(FINDING_CLAUSE_BOUNDARY).at(-1) ?? "";
    const suffix = text.slice(matchEnd).split(boundary)[0] ?? "";
    const full = priority
      ? (text.slice(matchEnd).split(/(?<!\d)\.|\.(?!\d)|[!?\n]/)[0] ?? suffix)
      : suffix;
    if (priority) {
      const context = text.slice(0, matchEnd).split(boundary).at(-1) ?? "";
      const broader = context.slice(0, -candidate[0].length);
      if (PRIORITY_COUNTED_ENTRY.test(broader))
        prefix =
          priorityCountContextValue(prefix, suffix) === null ? prefix : broader;
    }
    if (
      isSupported(prefix, suffix, full) &&
      !isNegatedFindingPrefix(prefix, suffix) &&
      !isEmptyFindingOccurrence(prefix, candidate[0], full)
    ) {
      return normalizeFindingSummary(candidate[0]).trim();
    }
  }
  return null;
}
// prettier-ignore
const affirmativeChangesRequested = (body) => affirmativeOccurrence(body, /\bchanges\s+requested\b/gi), affirmativeSeverity = (body) => affirmativeOccurrence(body, /\b(?:critical|high|medium|low)\s+severity\b/gi);
const PRIORITY_SIGNAL = /(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b)/gi;
const PRIORITY_COUNT_NUMBER_SOURCE = String.raw`(?:\d+(?:\.\d+)?|no|none|a|an|zero|one|two|three|four|five|six|seven|eight|nine)`;
const PRIORITY_FINDING_NOUN_SOURCE = String.raw`(?:${EMPTY_FINDING_NOUN_SOURCE}|observations?|comments?|items?|recommendations?)`;
const PRIORITY_BOUNDED_STATUS_SOURCE = String.raw`(?:remains?(?:\s+(?:unresolved|open|actionable|confirmed))?|exists?|persists?|(?:is|are|was|were)\s+(?:still\s+)?(?:present|unresolved|open|actionable|confirmed|found|reported|identified|detected|flagged|noted)|(?:found|reported|identified|detected|flagged|noted)|requires?\s+(?:a\s+)?fix|must\s+be\s+(?:addressed|fixed|resolved))`;
const FIXTURE_META_SOURCE = String.raw`(?:(?:(?:only|just|merely|solely)\s+(?:in|as)\s+|(?:in|as)\s+)(?:(?:parser|test|fixture|example|sample)\s+)*(?:fixtures?|examples?|samples?|tests?|test\s+cases?|data)(?:\s+(?:only|just|merely|solely))?|for\s+(?:(?:parser|test)\s+)?coverage|(?:it|this|that|the|these|those|they|all|both|each)(?:\s+(?:findings?|issues?|defects?|problems?|concerns?|errors?|observations?|comments?|items?|recommendations?|counts?|entries?))?\s+(?:(?:is|are|was|were)\s+(?:(?:only|just|merely|solely)\s+)?(?:(?:used|included|shown)\s+(?:(?:only|just|merely|solely)\s+)?(?:in|as)\s+)?|(?:(?:only|just|merely|solely)\s+)?(?:appears?|occurs?|exists?)\s+(?:(?:only|just|merely|solely)\s+)?in\s+)(?:(?:parser|test|fixture|example|sample)\s+)*(?:fixtures?|examples?|samples?|tests?|test\s+cases?|data)(?:\s+(?:only|just|merely|solely))?)`;
// prettier-ignore
const PRIORITY_BOUNDED_STATUS = new RegExp(String.raw`\b${PRIORITY_BOUNDED_STATUS_SOURCE}\b`, "iu");
const META_TAIL = new RegExp(String.raw`${FIXTURE_META_SOURCE}\s*$`, "iu");
const COPULAR_REPRESENTATIONAL_META_TAIL =
  /\b(?:it|this|that|the|these|those|they|all|both|each)(?:\s+(?:findings?|issues?|defects?|problems?|concerns?|errors?|observations?|comments?|items?|recommendations?|counts?|entries?))?\s+(?:is|are|was|were)\s+(?:(?:only|just|merely|solely)\s+)?(?:(?:used|included|shown)\s+(?:(?:only|just|merely|solely)\s+)?(?:in|as)\s+)?(?:(?:an?|the|this|that|these|those)\s+)?(?:(?:parser|test|fixture|example|sample)\s+)*(?:fixtures?|examples?|samples?|tests?|test\s+cases?|data)\b(?:\s+(?:used|included|shown)\s+in\s+(?:the\s+)?(?:tests?|fixtures?)|\s+for\s+(?:(?:parser|test)\s+)?coverage)?(?:\s+(?:only|just|merely|solely))?\s*$/i;
const COUNT_SERIES_SEPARATOR_SOURCE = String.raw`(?:(?:[,—–-]\s*)?(?:although|but|however|yet)\s+|,\s*(?:(?:and|or|nor)\s*)?|[;/&—–-]\s*|\b(?:and|or|nor)\b\s*)`;
const PRIORITY_FINDING_ENTRY_PREFIX =
  /^(?:\s*(?:(?:[-+•>]|#{1,6})\s+)*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:["'(“‘]\s*)?(?:(?:review\s+)?(?:findings?|issues?|defects?|problems?|concerns?|errors?)(?:\s+#?\d+)?\s*(?::|[—–-])\s*)?|\s*\|(?:[^|\n]*\|)*\s*)$/i;
const PRIORITY_COUNT_INTRO_SOURCE = String.raw`(?:(?:there\s+(?:are|is|was|were)|(?:i|we)\s+(?:found|reported)|the\s+(?:review|report|scan|analysis)\s+(?:found|reported|contains?|has|have)|this\s+(?:(?:review|report|scan|analysis)\s+)?(?:contains?|has|reports?))\s+)?`;
// prettier-ignore
const PRIORITY_COUNT_PREFIX = new RegExp(String.raw`^\s*(?:(?:[-+•>]|#{1,6})\s+)*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:["'(“‘]\s*)?(?:(?:findings?|summary|counts?|results?|review\s+(?:summary|results))\s*:\s*)?${PRIORITY_COUNT_INTRO_SOURCE}(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})\s*$`, "iu");
const PRIORITY_COUNTED_NOUN_SUFFIX = new RegExp(
  String.raw`^(?:\s*${PRIORITY_FINDING_NOUN_SOURCE}\b(?:\s+${PRIORITY_BOUNDED_STATUS_SOURCE})?\s*,?\s*|\s*(?:issues?|defects?|problems?|concerns?|errors?)\b\s+${PRIORITY_BOUNDED_STATUS_SOURCE}\s*(?:[,—–-]\s*)?(?:although|but|however|yet)\s+(?:it|this|that|they)\s+(?:(?:only|just|merely|solely)\s+)?(?:appears?|occurs?|exists?)\b[^.!?;\n]*)$`,
  "iu",
);
const PRIORITY_LABEL_FIRST_COUNT_SUFFIX = new RegExp(
  String.raw`^\s*(?:(?:${PRIORITY_FINDING_NOUN_SOURCE}(?:\s+(?:count|total))?\s*)?(?::|[=—–-])\s*(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})\b(?:\s+${PRIORITY_FINDING_NOUN_SOURCE})?(?:\s+${PRIORITY_BOUNDED_STATUS_SOURCE})?|\(\s*(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})(?:\s+${PRIORITY_FINDING_NOUN_SOURCE})?(?:\s+${PRIORITY_BOUNDED_STATUS_SOURCE})?\s*\)|(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})\s+${PRIORITY_FINDING_NOUN_SOURCE}\b(?:\s+${PRIORITY_BOUNDED_STATUS_SOURCE})?)\s*(?=$|${COUNT_SERIES_SEPARATOR_SOURCE}(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b))`,
  "iu",
);
// prettier-ignore
const COUNT_META = new RegExp(String.raw`^\s*(?:(?:${PRIORITY_FINDING_NOUN_SOURCE}(?:\s+(?:count|total))?\s*)?(?::|[=—–-])\s*|\(\s*)?(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})\s+(?:(findings?|observations?|comments?|items?|recommendations?)|(?:issues?|defects?|problems?|concerns?|errors?))\b([\s\S]*)$`, "iu");
const COUNT_CONTRAST = /(?:\b(?:although|but|however|yet)\b|;)\s*(\S[\s\S]*)$/i;
const ZERO_COUNT_DEFECT_TAIL =
  /^(?![^.!?;\n]*\b(?:as\s+expected|by\s+design|intentionally|(?:are|is|was|were)\s+expected)\b)[^.!?;\n]*\b(?:after|because|if|when)\b[^.!?;\n]{0,120}\b(?:crash(?:es|ed)?|fail(?:s|ed)?|failure)\b/i;
function contextualCountValue(value) {
  const match = COUNT_META.exec(normalizeFindingSummary(value));
  if (!match) return null;
  const contrast = match[3].match(COUNT_CONTRAST)?.[1] ?? null;
  const tail = contrast ?? `it ${match[3]}`;
  const isMeta =
    META_TAIL.test(match[3]) ||
    PRIORITY_CLAUSE_BOUNDARY.exec(`but ${tail}`)?.index !== 0;
  const count = findingCountValue(match[1]);
  if (count === 0 && ZERO_COUNT_DEFECT_TAIL.test(match[3])) return 1;
  // prettier-ignore
  if (isMeta && (match[2] || count === 0 || COPULAR_REPRESENTATIONAL_META_TAIL.test(match[3]))) return 0;
  return contrast === null ? null : count || 1;
}
const PRIORITY_COUNTED_ENTRY =
  /(?:(?:only\s+)?(?:\d+(?:\.\d+)?|no|none|a|an|zero|one|two|three|four|five|six|seven|eight|nine)\s+`?(?:\[[Pp][0-3]\]|\b[Pp][0-3]\b(?:\s+Badge)?)`?|`?(?:\[[Pp][0-3]\]|\b[Pp][0-3]\b(?:\s+Badge)?)`?\s*(?:(?:findings?|issues?|defects?|problems?|concerns?|errors?|observations?|comments?|items?|recommendations?)(?:\s+(?:count|total))?\s*)?(?:(?::|[=—–-])\s*|\(\s*)(?:\d+(?:\.\d+)?|no|none|a|an|zero|one|two|three|four|five|six|seven|eight|nine)\b)/iu;
const PRIORITY_PREVIOUS_EMPTY_ENTRY_SEPARATOR =
  /(?:[,/&—–-]|\b(?:although|and|but|however|nor|or|yet))\s*$/i;
function hasPriorityFindingEntryContext(prefix) {
  const normalized = normalizeFindingSummary(prefix);
  if (PRIORITY_FINDING_ENTRY_PREFIX.test(normalized)) return true;
  const separator = normalized.match(PRIORITY_PREVIOUS_EMPTY_ENTRY_SEPARATOR);
  if (!separator || separator.index === undefined) return false;
  const previous = normalized.slice(0, separator.index);
  if (isEmptyFindingSummary(previous)) return true;
  const end = previous.indexOf(":") + 1;
  if (!end || !COUNT_SERIES_PREFIX.test(previous.slice(0, end))) return false;
  return isEmptyFindingSummary(previous.slice(end));
}
function priorityCountContextValue(prefix, suffix) {
  const normalizedPrefix = normalizeFindingSummary(prefix);
  const normalizedSuffix = normalizeFindingSummary(suffix);
  const prefixMatch = PRIORITY_COUNT_PREFIX.exec(normalizedPrefix);
  if (prefixMatch && PRIORITY_COUNTED_NOUN_SUFFIX.test(normalizedSuffix))
    return findingCountValue(prefixMatch[1]);
  const suffixMatch = PRIORITY_LABEL_FIRST_COUNT_SUFFIX.exec(normalizedSuffix);
  const count = suffixMatch?.slice(1).find((value) => value !== undefined);
  const supported =
    COUNT_SERIES_PREFIX.test(normalizedPrefix) ||
    (/\b(?:although|but|however|yet)\s*$/i.test(normalizedPrefix) &&
      PRIORITY_BOUNDED_STATUS.test(normalizedSuffix) &&
      !META_TAIL.test(normalizedSuffix)) ||
    hasPriorityFindingEntryContext(prefix);
  if (count !== undefined) return supported ? findingCountValue(count) : null;
  return contextualCountValue(
    prefixMatch ? `${prefixMatch[1]} ${normalizedSuffix}` : normalizedSuffix,
  );
}
function supportsPriority(prefix, suffix, full) {
  if (prefix.endsWith("!") || /^[([]/u.test(suffix)) return false;
  const count = priorityCountContextValue(prefix, full);
  return count === null ? hasPriorityFindingEntryContext(prefix) : count !== 0;
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
const isMarkdownTableSeparator = (cells) =>
  Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)));
function findingLabelCellSignal(cell) {
  if (!FINDING_TABLE_LABEL_CELL.test(cell)) return null;
  return cell.match(FINDING_LABEL)?.[0] ?? null;
}
function findingTableCountValue(cell) {
  let text = normalizeFindingSummary(cell).trim();
  text = text.replace(/^only\s+/iu, "");
  const [count] = text.split(/\s+/u);
  if (!count) return null;
  const value = findingCountValue(count);
  const suffix = text.slice(count.length);
  if (
    !suffix.trim() ||
    PRIORITY_COUNTED_NOUN_SUFFIX.test(suffix) ||
    PRIORITY_COUNTED_NOUN_SUFFIX.test(`findings${suffix}`)
  )
    return value;
  return contextualCountValue(text) === 0 ? 0 : null;
}
function hasActionableFindingTableProse(row, proseColumns) {
  return proseColumns.some((column) => {
    const cell = normalizeFindingSummary(row[column] ?? "")
      .trim()
      .replace(/[.!]+$/u, "")
      .trim();
    return Boolean(
      cell &&
      !EMPTY_FINDING_TABLE_CELL.test(cell) &&
      !EMPTY_FINDING_TRAILING_CLAUSE.test(cell) &&
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
      const signal = findingLabelCellSignal(headerCells[column]);
      for (const row of rows) {
        const count = findingTableCountValue(row[column]);
        if (count === null) return { handled: false, signal: null };
        if (hasActionableFindingTableProse(row, proseColumns) || count !== 0) {
          return { handled: true, signal };
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
const COUNT_SERIES_PREFIX =
  /^\s*(?:(?:[-+•>]|#{1,6})\s+)*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:(?:findings?|summary|counts?|results?|review\s+(?:summary|results))\s*:\s*)?(?:only\s+)?$/i;
const SEVERITY_COUNT_ITEM_SOURCE = String.raw`${PRIORITY_COUNT_NUMBER_SOURCE}\s+\b(?:critical|high|medium|low)\b(?:\s+severity)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`;
const PRIORITY_COUNT_LABEL_SOURCE = String.raw`(?:\[[Pp][0-3]\]|\b[Pp][0-3]\b(?:\s+Badge)?)`;
const PRIORITY_COUNT_ITEM_SOURCE = String.raw`(?:only\s+)?${PRIORITY_COUNT_NUMBER_SOURCE}\s+${PRIORITY_COUNT_LABEL_SOURCE}(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?(?:\s+${PRIORITY_BOUNDED_STATUS_SOURCE})?`;
const SEVERITY_COUNT_SERIES = new RegExp(
  String.raw`\b(?=${PRIORITY_COUNT_NUMBER_SOURCE}\s+)(?=[^.!?;\n]*\bseverity\b)${SEVERITY_COUNT_ITEM_SOURCE}(?:\s*${COUNT_SERIES_SEPARATOR_SOURCE}\s*${SEVERITY_COUNT_ITEM_SOURCE})+(?!\s*;\s*${SEVERITY_COUNT_ITEM_SOURCE})(?!\s*;\s*(?:(?:however|but|yet),?\s+)?${FIXTURE_META_SOURCE}\s*[.!?]?(?:\n|$))`,
  "gi",
);
const PRIORITY_COUNT_SERIES = new RegExp(
  String.raw`\b${PRIORITY_COUNT_ITEM_SOURCE}(?:\s*${COUNT_SERIES_SEPARATOR_SOURCE}\s*${PRIORITY_COUNT_ITEM_SOURCE})+(?!\s*;\s*${PRIORITY_COUNT_ITEM_SOURCE})(?!\s*;\s*(?:(?:however|but|yet),?\s+)?${FIXTURE_META_SOURCE}\s*[.!?]?(?:\n|$))(?=\s*(?:[.!?;\n]|$))`,
  "gi",
);
const SEVERITY_COUNT_ITEM = new RegExp(
  String.raw`\b(${PRIORITY_COUNT_NUMBER_SOURCE})\s+(critical|high|medium|low)\b(?:\s+severity)?(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`,
  "gi",
);
const PRIORITY_COUNT_ITEM = new RegExp(
  String.raw`\b(?:only\s+)?(${PRIORITY_COUNT_NUMBER_SOURCE})\s+(${PRIORITY_COUNT_LABEL_SOURCE})(?:\s+${EMPTY_FINDING_NOUN_SOURCE})?`,
  "gi",
);
function nonzeroCountLabel(body, priority = false) {
  const text = String(body ?? "");
  const series = priority ? PRIORITY_COUNT_SERIES : SEVERITY_COUNT_SERIES;
  const item = priority ? PRIORITY_COUNT_ITEM : SEVERITY_COUNT_ITEM;
  for (const match of text.matchAll(series)) {
    const prefix =
      text
        .slice(0, match.index ?? 0)
        .split(FINDING_CLAUSE_BOUNDARY)
        .at(-1) ?? "";
    const normalized = normalizeFindingSummary(prefix).trim();
    if (priority && !COUNT_SERIES_PREFIX.test(normalized)) continue;
    if (NEGATED_REVIEW_RESULT_PREFIX.test(normalized)) continue;
    for (const count of match[0].matchAll(item)) {
      if (findingCountValue(count[1]) !== 0)
        return count[0].match(FINDING_LABEL)?.[0] ?? count[2];
    }
  }
  return null;
}
const COUNT_WORDS = "zero one two three four five six seven eight nine";
function findingCountValue(value) {
  const normalized = String(value ?? "").toLowerCase();
  const wordValue = COUNT_WORDS.split(" ").indexOf(normalized);
  if (wordValue >= 0) return wordValue;
  if (/^(?:no|none)$/u.test(normalized)) return 0;
  return /^(?:a|an)$/u.test(normalized) ? 1 : Number(normalized);
}
const countSeriesSignal = (body) =>
  nonzeroCountLabel(body, true) ?? nonzeroCountLabel(body);
function withoutNegatedCountSeries(body) {
  let text = String(body ?? "");
  for (const pattern of [PRIORITY_COUNT_SERIES, SEVERITY_COUNT_SERIES]) {
    text = text.replace(pattern, (series, ...args) => {
      const prefix =
        text.slice(0, args.at(-2)).split(FINDING_CLAUSE_BOUNDARY).at(-1) ?? "";
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
const REVIEW_LOCATION_SOURCE = String.raw`(?:\s+(?:in|at)\s+\`?[A-Za-z0-9_./-]+(?::\d+(?:-\d+)?)?\`?)?`;
const VERIFIED_PROSE_UPDATE_SOURCE = String.raw`(?:comment(?:\/prose)?|prose|documentation|docs?)\s+(?:update|change|wording)${REVIEW_LOCATION_SOURCE}\s+(?:is|are|was|were)\s+(?:accurate|correct|valid|sound)`;
const OBSERVED_BLIND_JUDGE_EXPLANATION_SOURCE = String.raw`(?:[.!?]?[ \t]+\`blindJudgeCwd\(\)\`(?:'s|’s)[ \t]+docstring[ \t]+was[ \t]+updated[ \t]+to[ \t]+describe[ \t]+the[ \t]+empty[ \t]+scratch[ \t]+dir[ \t]+as[ \t]+defense-in-depth[ \t]+against[ \t]+the[ \t]+CLI[ \t]+ever[ \t]+failing[ \t]+to[ \t]+honor[ \t]+\`--tools[ \t]+""\`,[ \t]+rather[ \t]+than[ \t]+as[ \t]+the[ \t]+primary[ \t]+safeguard[ \t]*[—–-][ \t]*correctly[ \t]+reflects[ \t]+the[ \t]+new[ \t]+design[ \t]+where[ \t]+\`--tools[ \t]+""\`[ \t]+is[ \t]+now[ \t]+the[ \t]+primary[ \t]+control)?`;
const REVIEW_ITEM_END_SOURCE = String.raw`[.!?]?[ \t]*(?=(?:(?:\r?\n)[ \t]*)*(?:(?:[-+•>]|#{1,6})[ \t]+|\d+[.)][ \t]+|${BRACKETED_PRIORITY_SOURCE}|(?![\s\S])))`;
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
  new RegExp(
    String.raw`${PRIORITY_CLAUSE_LEAD_SOURCE}${BRACKETED_PRIORITY_LIST_SOURCE}\s+${VERIFIED_PROSE_UPDATE_SOURCE}${OBSERVED_BLIND_JUDGE_EXPLANATION_SOURCE}${REVIEW_ITEM_END_SOURCE}`,
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
  if (String(reviewState ?? "").toUpperCase() === "CHANGES_REQUESTED") {
    return "review state: CHANGES_REQUESTED";
  }
  if (
    bot !== "coderabbit" &&
    bot !== "cursor" &&
    !FINDING_HINT.test(String(value ?? ""))
  ) {
    return null;
  }
  if (bot === "claude" && isResolvedImageReferenceOnly(value)) return null;
  const markdown = parseMarkdownEvidence(value, {
    maskRawHtmlNonProse: true,
    preserveGitHubAlerts: true,
    preserveInlineCode: bot !== "coderabbit" && bot !== "cursor",
    preserveSignalComments: bot === "coderabbit" || bot === "cursor",
  });
  const botSignal = botSpecificFindingSignal(markdown.body, bot);
  if (botSignal !== undefined) return botSignal;
  const tableAnalysis = analyzeFindingTables(markdown.formattedBody());
  if (tableAnalysis.signal !== null) return tableAnalysis.signal;
  const proseBody = withoutNegatedPriorityClauses(
    withoutNegatedCountSeries(boundedFindingProse(tableAnalysis.body)),
  );
  // prettier-ignore
  return (
    countSeriesSignal(proseBody) ??
    affirmativeOccurrence(proseBody, PRIORITY_SIGNAL, supportsPriority) ??
    affirmativeSeverity(proseBody) ??
    affirmativeChangesRequested(proseBody)
  );
}
