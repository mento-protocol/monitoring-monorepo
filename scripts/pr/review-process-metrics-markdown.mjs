import { fromMarkdown } from "mdast-util-from-markdown";

const MASKED_NODE_TYPES = new Set(["blockquote", "code", "inlineCode"]);
const GITHUB_ALERT_START =
  /^[ \t]{0,3}>[ \t]?\[!(?:CAUTION|IMPORTANT|NOTE|TIP|WARNING)\][ \t]*(?:\r?\n|$)/i;

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

function rawHtmlNonProseRanges(source) {
  return [
    ...source.matchAll(/<!--[\s\S]*?(?:-->|$)/g),
    ...source.matchAll(/<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function maskMarkdownNonProse(
  value,
  {
    maskRawHtmlNonProse = false,
    preserveGitHubAlerts = false,
    preserveInlineCode = false,
  } = {},
) {
  const source = String(value ?? "");
  if (source === "") return source;

  const ranges = collectMaskedRanges(
    fromMarkdown(source),
    source,
    preserveGitHubAlerts,
    preserveInlineCode,
  );
  if (maskRawHtmlNonProse) ranges.push(...rawHtmlNonProseRanges(source));
  let cursor = 0;
  let masked = "";
  for (const { start, end } of mergeRanges(ranges)) {
    masked += source.slice(cursor, start);
    masked += source.slice(start, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return masked + source.slice(cursor);
}
