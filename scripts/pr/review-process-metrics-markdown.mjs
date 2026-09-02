import { fromMarkdown } from "mdast-util-from-markdown";

const MASKED_NODE_TYPES = new Set(["blockquote", "code", "inlineCode"]);
const GITHUB_ALERT_START =
  /^[ \t]{0,3}>[ \t]?\[!(?:CAUTION|IMPORTANT|NOTE|TIP|WARNING)\][ \t]*(?:\r?\n|$)/i;
const SIMPLE_IMAGE_REFERENCE_LINE =
  /^!\[[A-Za-z0-9 _.-]{0,256}\]\[([A-Za-z0-9_-]{1,64})\][ \t]*$/u;
const SIMPLE_HTTPS_DEFINITION_LINE =
  /^\[([A-Za-z0-9_-]{1,64})\]:[ \t]+https:\/\/[A-Za-z0-9.-]{1,253}\/?[ \t]*$/u;

export function isResolvedImageReferenceOnly(value) {
  const source = String(value ?? "");
  const references = new Set();
  const definitions = new Set();
  let foundImage = false;
  let separatedDefinitions = false;
  let readingDefinitions = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^[ \t]*$/u.test(line)) {
      if (foundImage) separatedDefinitions = true;
      continue;
    }
    const image = readingDefinitions
      ? null
      : SIMPLE_IMAGE_REFERENCE_LINE.exec(line);
    if (image !== null) {
      foundImage = true;
      separatedDefinitions = false;
      references.add(image[1].toLowerCase());
      continue;
    }
    const definition = SIMPLE_HTTPS_DEFINITION_LINE.exec(line);
    if (!foundImage || !separatedDefinitions || definition === null) {
      return false;
    }
    readingDefinitions = true;
    definitions.add(definition[1].toLowerCase());
  }
  if (
    !foundImage ||
    definitions.size === 0 ||
    [...references].some((reference) => !definitions.has(reference))
  ) {
    return false;
  }
  return true;
}

function sourceSpan(node, sourceLength) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > sourceLength
  ) {
    throw new Error(`invalid Markdown ${node.type} source span`);
  }
  return { start, end };
}

function collectMaskedRanges(
  tree,
  source,
  preserveGitHubAlerts,
  preserveInlineCode,
) {
  const ranges = [];
  const pending = [{ node: tree, parentType: null }];
  while (pending.length > 0) {
    const { node, parentType } = pending.pop();
    if (node.type === "blockquote") {
      const span = sourceSpan(node, source.length);
      if (
        preserveGitHubAlerts &&
        parentType === "root" &&
        GITHUB_ALERT_START.test(source.slice(span.start, span.end))
      ) {
        pending.push(
          ...(node.children ?? []).map((child) => ({
            node: child,
            parentType: node.type,
          })),
        );
        continue;
      }
    }
    if (node.type === "inlineCode" && preserveInlineCode) continue;
    if (MASKED_NODE_TYPES.has(node.type)) {
      const { start, end } = sourceSpan(node, source.length);
      if (end > start) ranges.push({ start, end });
      continue;
    }
    pending.push(
      ...(node.children ?? []).map((child) => ({
        node: child,
        parentType: node.type,
      })),
    );
  }
  return ranges;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

const SIGNAL_COMMENT = /^<!--\s*(?:cr-indicator-types\s*:|BUGBOT_BUG_ID\b)/i;
function htmlTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index + 1;
  }
  return source.length;
}

function collectHtmlFormattingRanges(source, node, ranges) {
  const span = sourceSpan(node, source.length);
  let cursor = span.start;
  while (cursor < span.end) {
    const start = source.indexOf("<", cursor);
    if (start === -1 || start >= span.end) break;
    if (!/^<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>])/u.test(source.slice(start))) {
      cursor = start + 1;
      continue;
    }
    const end = Math.min(htmlTagEnd(source, start), span.end);
    ranges.push({ start, end });
    cursor = end;
  }
}

function formattingSyntaxRanges(tree, source) {
  const ranges = [];
  const pending = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "html") {
      collectHtmlFormattingRanges(source, node, ranges);
    }
    if (
      node.type === "link" ||
      node.type === "linkReference" ||
      node.type === "emphasis" ||
      node.type === "strong"
    ) {
      const span = sourceSpan(node, source.length);
      const childSpans = (node.children ?? [])
        .map((child) => sourceSpan(child, source.length))
        .sort((left, right) => left.start - right.start);
      if (childSpans.length === 0) {
        ranges.push(span);
      } else {
        const first = childSpans[0];
        const last = childSpans.at(-1);
        if (span.start < first.start) {
          ranges.push({ start: span.start, end: first.start });
        }
        if (last.end < span.end) {
          ranges.push({ start: last.end, end: span.end });
        }
      }
    }
    if (node.type === "image" || node.type === "imageReference") {
      ranges.push(sourceSpan(node, source.length));
    }
    if (node.type === "definition") {
      ranges.push(sourceSpan(node, source.length));
    }
    pending.push(...(node.children ?? []));
  }
  return ranges;
}

function isBackslashEscaped(source, index) {
  let backslashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function literalHtmlCommentRanges(source, markdownRanges) {
  const comments = [];
  for (const range of markdownRanges) {
    let cursor = range.start;
    while (cursor < range.end) {
      const start = source.indexOf("<!--", cursor);
      if (start === -1 || start >= range.end) break;
      const closing = source.indexOf("-->", start + 4);
      const end =
        closing === -1 || closing + 3 > range.end ? range.end : closing + 3;
      comments.push({ start, end });
      cursor = end;
    }
  }
  return comments;
}

function rawHtmlNonProseRanges(source, preserveSignalComments, markdownRanges) {
  const comments = [];
  const containers = [];
  const openContainers = new Map();
  const excluded = mergeRanges(markdownRanges);
  const literalComments = literalHtmlCommentRanges(source, excluded);
  let excludedIndex = 0;
  let cursor = 0;
  while (cursor < source.length) {
    while (excluded[excludedIndex]?.end <= cursor) excludedIndex += 1;
    const excludedRange = excluded[excludedIndex];
    if (excludedRange !== undefined && excludedRange.start <= cursor) {
      cursor = excludedRange.end;
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const closing = source.indexOf("-->", cursor + 4);
      const end = closing === -1 ? source.length : closing + 3;
      comments.push({ start: cursor, end });
      cursor = end;
      continue;
    }
    if (source[cursor] !== "<") {
      cursor += 1;
      continue;
    }
    if (isBackslashEscaped(source, cursor)) {
      cursor += 1;
      continue;
    }
    const tag = /^<(\/)?(pre|code|blockquote)\b/i.exec(source.slice(cursor));
    const genericTag = /^<\/?[A-Za-z][A-Za-z0-9:-]*\b/.test(
      source.slice(cursor),
    );
    if (tag === null) {
      cursor = genericTag ? htmlTagEnd(source, cursor) : cursor + 1;
      continue;
    }
    const end = htmlTagEnd(source, cursor);
    const name = tag[2].toLowerCase();
    const open = openContainers.get(name);
    if (tag[1] === undefined) {
      if (open === undefined) {
        openContainers.set(name, { depth: 1, start: cursor });
      } else {
        open.depth += 1;
      }
    } else if (open !== undefined) {
      open.depth -= 1;
      if (open.depth === 0) {
        containers.push({ start: open.start, end });
        openContainers.delete(name);
      }
    }
    cursor = end;
  }
  for (const { start } of openContainers.values()) {
    containers.push({ start, end: source.length });
  }
  return [
    ...comments.filter(
      ({ start, end }) =>
        !preserveSignalComments ||
        !SIGNAL_COMMENT.test(source.slice(start, end)),
    ),
    ...literalComments,
    ...containers,
  ];
}

function maskRanges(source, ranges) {
  let cursor = 0;
  let masked = "";
  for (const { start, end } of mergeRanges(ranges)) {
    masked += source.slice(cursor, start);
    masked += source.slice(start, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return masked + source.slice(cursor);
}

function formattingProjection(source, tree, body) {
  return maskRanges(body, formattingSyntaxRanges(tree, source));
}

function nonProseProjection(
  source,
  tree,
  {
    maskRawHtmlNonProse = false,
    preserveSignalComments = false,
    preserveGitHubAlerts = false,
    preserveInlineCode = false,
  } = {},
) {
  const ranges = collectMaskedRanges(
    tree,
    source,
    preserveGitHubAlerts,
    preserveInlineCode,
  );
  if (maskRawHtmlNonProse) {
    const markdownRanges = collectMaskedRanges(tree, source, false, false);
    ranges.push(
      ...rawHtmlNonProseRanges(source, preserveSignalComments, markdownRanges),
    );
  }
  return maskRanges(source, ranges);
}

export function parseMarkdownEvidence(value, options = {}) {
  const source = String(value ?? "");
  if (source === "") {
    return { body: "", formattedBody: () => "" };
  }
  const tree = fromMarkdown(source);
  const body = nonProseProjection(source, tree, options);
  return {
    body,
    formattedBody: () => formattingProjection(source, tree, body),
  };
}

export function maskMarkdownFormattingSyntax(value) {
  const source = String(value ?? "");
  if (source === "") return source;
  const tree = fromMarkdown(source);
  return formattingProjection(source, tree, source);
}

export function maskMarkdownNonProse(value, options = {}) {
  const source = String(value ?? "");
  if (source === "") return source;
  const tree = fromMarkdown(source);
  return nonProseProjection(source, tree, options);
}
