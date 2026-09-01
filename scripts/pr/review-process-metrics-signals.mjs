import { fromMarkdown } from "mdast-util-from-markdown";

import {
  REVIEW_BOT_KEYS,
  authorLogin,
  baseEvidence,
  botKeyForLogin,
  isTrustedRequestAuthor,
} from "./review-process-metrics-core.mjs";
import {
  effectiveHeadBeforeComment,
  provenForcePush,
} from "./review-process-metrics-timeline.mjs";
import { maskMarkdownNonProse } from "./review-process-metrics-markdown.mjs";

const CANONICAL_RUN_ID_LINE =
  /^ {0,3}\*\*Run ID\*\*:[ \t]*`([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})`[ \t]*(?=\r?$)/gim;

function rootLines(value, pattern, nodeType, exactNode = false) {
  const source = String(value ?? "");
  const ranges = fromMarkdown(source)
    .children.filter(
      ({ type, children = [] }) =>
        type === nodeType && !children.some((child) => child.type === "html"),
    )
    .map(({ position }) => [position.start.offset, position.end.offset]);
  return [...source.matchAll(pattern)].filter((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return ranges.some(([nodeStart, nodeEnd]) =>
      exactNode
        ? nodeStart === start && nodeEnd === end
        : nodeStart <= start && nodeEnd >= end,
    );
  });
}

function extractRunIds(body) {
  return rootLines(body, CANONICAL_RUN_ID_LINE, "paragraph").map((match) =>
    match[1].toLowerCase(),
  );
}

function signalEvidence(value, { prUrl, type, surface = "issue_comments" }) {
  return {
    ...baseEvidence(value, { prUrl, surface }),
    type,
  };
}

const ROOT_CODERABBIT_SIGNAL_MARKER =
  /^(?:[ \t]*\r?\n)*(?: {0,3}<!--\s*This is an auto-generated comment:\s*summarize by coderabbit\.ai\s*-->[ \t]*\r?\n)? {0,3}<!--\s*This is an auto-generated comment:\s*(review paused|rate limited|skip review) by coderabbit\.ai\s*-->[ \t]*(?:\r?\n|$)/i;
const ROOT_CODERABBIT_COMPLETION_MARKER =
  /^(?:[ \t]*\r?\n)*(?: {0,3}<!--\s*This is an auto-generated comment:\s*summarize by coderabbit\.ai\s*-->[ \t]*\r?\n)? {0,3}<!--\s*This is an auto-generated comment:\s*(?:summarize|skip review) by coderabbit\.ai\s*-->[ \t]*(?:\r?\n|$)/i;
const RECENT_REVIEW_MARKER =
  /^ {0,3}<!--[ \t]*recent_review_(start|end)[ \t]*-->[ \t]*(?=\r?$)/gim;
const ROOT_CODERABBIT_FINAL_HEAD_COMMENT =
  /^ {0,3}<!--\s*coderabbit-final-head-review:[\s\S]*?(?:-->|(?![\s\S]))[ \t]*(?=\r?(?:\n|$))/gim;
const ROOT_CODERABBIT_FINAL_HEAD_MARKER =
  /^ {0,3}<!--\s*coderabbit-final-head-review:([0-9a-f]{40})\s*-->[ \t]*(?=\r?$)/gim;

function directBlockquoteStatusEnvelope(value) {
  const source = String(value ?? "");
  const leadingBlank = /^(?:[ \t]*\r?\n)*/.exec(source)?.[0] ?? "";
  let cursor = leadingBlank.length;
  let envelope = "";
  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? source.length : newline + 1;
    const line = source.slice(cursor, lineEnd);
    const quoted = /^[ \t]{0,3}>[ \t]?([^\r\n]*)(\r?\n|$)/.exec(line);
    if (quoted === null || quoted[0].length !== line.length) break;
    envelope += `${quoted[1]}${quoted[2]}`;
    cursor = lineEnd;
  }
  return envelope === "" ? source : envelope;
}

function detectedCodeRabbitSignals(comment) {
  const body = String(comment.body ?? "");
  const marker = ROOT_CODERABBIT_SIGNAL_MARKER.exec(body);
  if (marker === null) return [];
  const markerKind = marker[1].toLowerCase();
  const statusText = maskMarkdownNonProse(
    directBlockquoteStatusEnvelope(body.slice(marker[0].length)),
    { maskRawHtmlNonProse: true },
  );
  const signals = [];
  if (
    markerKind === "review paused" &&
    /##\s*Reviews paused/i.test(statusText)
  ) {
    signals.push("pause");
  }
  if (
    markerKind === "rate limited" &&
    /##\s*Review limit reached/i.test(statusText)
  ) {
    signals.push("rate_limit");
  }
  if (
    markerKind === "skip review" &&
    /Review was skipped due to path filters/i.test(statusText)
  ) {
    signals.push("path_filter_skip");
  }
  if (
    markerKind === "skip review" &&
    /does not receive automatic reviews because it has fewer than 10 stars/i.test(
      statusText,
    )
  ) {
    signals.push("free_tier_notice");
  }
  return signals;
}

function completedCodeRabbitReviewRunIds(value, surface) {
  const body = String(value.body ?? "");
  if (surface === "review_submissions") {
    const runIds = extractRunIds(body);
    return runIds.length === 1 ? runIds : [];
  }
  if (surface !== "issue_comments") return [];

  const rootMarker = ROOT_CODERABBIT_COMPLETION_MARKER.exec(body);
  if (rootMarker === null) return [];
  const source = body.slice(rootMarker[0].length);
  const markers = rootLines(source, RECENT_REVIEW_MARKER, "html", true);
  const starts = markers.filter(([, kind]) => kind.toLowerCase() === "start");
  const ends = markers.filter(([, kind]) => kind.toLowerCase() === "end");
  if (starts.length !== 1 || ends.length !== 1) return [];

  const blockStart = (starts[0].index ?? 0) + starts[0][0].length;
  const blockEnd = ends[0].index ?? -1;
  if (blockEnd < blockStart) return [];

  const block = maskMarkdownNonProse(source, {
    maskRawHtmlNonProse: true,
  }).slice(blockStart, blockEnd);
  if (
    !/(?:^|\n)[ \t]*No actionable comments were generated in the recent review\.(?:[ \t]+🎉)?[ \t]*(?=\r?(?:\n|$))/i.test(
      block,
    )
  ) {
    return [];
  }
  const runIds = extractRunIds(source.slice(blockStart, blockEnd));
  return runIds.length === 1 ? runIds : [];
}

function requestTargets(body) {
  const text = maskMarkdownNonProse(body, { maskRawHtmlNonProse: true });
  return [
    ["coderabbit", /(?:^|\n)\s*@coderabbitai\s+review\s*(?:\n|$)/i],
    ["codex", /(?:^|\n)\s*@codex\s+review\s*(?:\n|$)/i],
    ["claude", /(?:^|\n)\s*@claude\s+review\s*(?:\n|$)/i],
    ["cursor", /(?:^|\n)\s*bugbot\s+run\s*(?:\n|$)/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([target]) => target);
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalizedFullSha(value) {
  const text = typeof value === "string" ? value : "";
  return FULL_SHA_PATTERN.test(text) ? text.toLowerCase() : null;
}

export function pullRequestEvidenceHeads(pr, commits, timeline) {
  const committedHeads = timeline
    .filter(({ event }) => event === "committed")
    .map(({ sha }) => normalizedFullSha(sha));
  const forcePushHeads = timeline.flatMap((event) => {
    if (event?.event !== "head_ref_force_pushed") return [];
    const proof = provenForcePush(event);
    return proof.reason === null ? [proof.beforeHead, proof.afterHead] : [];
  });
  return [
    normalizedFullSha(pr.head?.sha),
    ...commits.map(({ sha }) => normalizedFullSha(sha)),
    ...committedHeads,
    ...forcePushHeads,
  ].filter(Boolean);
}

function evidenceTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stableNodeId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strictDatabaseId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function matchTimelineComment(comment, timeline) {
  if (!Array.isArray(timeline)) {
    return { item: null, index: null, reason: "timeline_is_not_an_array" };
  }
  const commented = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.event === "commented");
  const nodeId = stableNodeId(comment.node_id);
  if (nodeId !== null) {
    const matches = commented.filter(
      ({ item }) => stableNodeId(item.node_id) === nodeId,
    );
    if (matches.length > 1) {
      return {
        item: null,
        index: null,
        reason: "timeline_comment_node_id_is_ambiguous",
      };
    }
    if (matches.length === 1) {
      const commentId = strictDatabaseId(comment.id);
      const timelineId = strictDatabaseId(matches[0].item.id);
      if (
        commentId !== null &&
        timelineId !== null &&
        commentId !== timelineId
      ) {
        return {
          item: null,
          index: null,
          reason: "timeline_comment_id_conflicts_with_node_id",
        };
      }
      return { ...matches[0], reason: null };
    }
  }

  const commentId = strictDatabaseId(comment.id);
  if (commentId === null) {
    return {
      item: null,
      index: null,
      reason: "request_comment_has_no_stable_identity",
    };
  }
  const idMatches = commented.filter(
    ({ item }) => strictDatabaseId(item.id) === commentId,
  );
  if (idMatches.length === 0) {
    return { item: null, index: null, reason: "timeline_comment_not_found" };
  }
  if (idMatches.length > 1) {
    return {
      item: null,
      index: null,
      reason: "timeline_comment_id_is_ambiguous",
    };
  }
  const matchedNodeId = stableNodeId(idMatches[0].item.node_id);
  if (nodeId !== null && matchedNodeId !== null && nodeId !== matchedNodeId) {
    return {
      item: null,
      index: null,
      reason: "timeline_comment_node_id_mismatch",
    };
  }
  return { ...idMatches[0], reason: null };
}

function proveCommentRecency(comment, timelineComment) {
  const createdAt = evidenceTimestamp(comment.created_at);
  const timelineCreatedAt = evidenceTimestamp(timelineComment.created_at);
  if (createdAt === null || timelineCreatedAt === null) {
    return {
      timestamp: null,
      reason: "timeline_comment_created_at_is_unprovable",
    };
  }
  if (createdAt !== timelineCreatedAt) {
    return {
      timestamp: null,
      reason: "timeline_comment_created_at_mismatch",
    };
  }

  const updatedAt = evidenceTimestamp(comment.updated_at);
  const timelineUpdatedAt = evidenceTimestamp(timelineComment.updated_at);
  if (updatedAt === null || timelineUpdatedAt === null) {
    return {
      timestamp: null,
      reason: "timeline_comment_updated_at_is_unprovable",
    };
  }
  if (updatedAt !== timelineUpdatedAt) {
    return {
      timestamp: null,
      reason: "timeline_comment_updated_at_mismatch",
    };
  }
  if (updatedAt !== createdAt) {
    return { timestamp: null, reason: "request_comment_was_edited" };
  }
  return { timestamp: createdAt, reason: null };
}

function proveMarkerHeadAtComment(comment, markerHead, timeline) {
  const matched = matchTimelineComment(comment, timeline);
  if (matched.reason !== null) {
    return {
      kind: "unknown",
      reason: matched.reason,
      effectiveHead: null,
      timelineCommentNodeId: null,
      timelineCommentIndex: null,
    };
  }
  const recency = proveCommentRecency(comment, matched.item);
  if (recency.reason !== null) {
    return {
      kind: "unknown",
      reason: recency.reason,
      effectiveHead: null,
      timelineCommentNodeId: stableNodeId(matched.item.node_id),
      timelineCommentIndex: matched.index,
    };
  }
  const effective = effectiveHeadBeforeComment(
    timeline,
    matched.index,
    recency.timestamp,
  );
  if (effective.reason !== null) {
    return {
      kind: "unknown",
      reason: effective.reason,
      effectiveHead: effective.head,
      timelineCommentNodeId: stableNodeId(matched.item.node_id),
      timelineCommentIndex: matched.index,
    };
  }
  return {
    kind: effective.head === markerHead ? "marked_exact_head" : "unknown",
    reason:
      effective.head === markerHead
        ? null
        : "marker_was_not_effective_head_at_request",
    effectiveHead: effective.head,
    timelineCommentNodeId: stableNodeId(matched.item.node_id),
    timelineCommentIndex: matched.index,
  };
}

function classifyRequestMarker(comment, target, knownHeads, timeline) {
  const markerStarts = rootLines(
    comment.body,
    ROOT_CODERABBIT_FINAL_HEAD_COMMENT,
    "html",
    true,
  );
  if (target !== "coderabbit" || markerStarts.length === 0) {
    return {
      kind: "bare",
      head: null,
      reason: null,
      effectiveHead: null,
      timelineCommentNodeId: null,
      timelineCommentIndex: null,
    };
  }
  const heads = rootLines(
    comment.body,
    ROOT_CODERABBIT_FINAL_HEAD_MARKER,
    "html",
    true,
  ).map((match) => match[1].toLowerCase());
  if (markerStarts.length !== 1 || heads.length !== 1) {
    return {
      kind: "unknown",
      head: null,
      reason: "malformed_head_marker",
      effectiveHead: null,
      timelineCommentNodeId: null,
      timelineCommentIndex: null,
    };
  }
  const head = heads[0];
  if (!knownHeads.has(head)) {
    return {
      kind: "unknown",
      head,
      reason: "head_not_in_pr_history",
      effectiveHead: null,
      timelineCommentNodeId: null,
      timelineCommentIndex: null,
    };
  }
  return { ...proveMarkerHeadAtComment(comment, head, timeline), head };
}

function summarizeManualRequests(evidence, rejectedEvidence) {
  const markerCounts = new Map();
  for (const request of evidence) {
    if (request.marker !== "marked_exact_head") continue;
    markerCounts.set(request.head, (markerCounts.get(request.head) ?? 0) + 1);
  }
  return {
    count: evidence.length,
    markedExactHead: evidence.filter(
      ({ marker }) => marker === "marked_exact_head",
    ).length,
    bare: evidence.filter(({ marker }) => marker === "bare").length,
    unknown: evidence.filter(({ marker }) => marker === "unknown").length,
    uniqueExactHeads: markerCounts.size,
    duplicateExactHeadRequests: [...markerCounts.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    rejectedCount: rejectedEvidence.length,
    evidence,
    rejectedEvidence,
  };
}

export function buildSignals({
  prUrl,
  currentHeadOid,
  commits,
  issueComments,
  reviews,
  timeline = [],
}) {
  const evidence = {
    reviewRuns: [],
    pauses: [],
    rateLimits: [],
    pathFilterSkips: [],
    freeTierNotices: [],
    manualRequests: [],
    rejectedManualRequests: [],
  };
  const knownHeads = new Set(
    [
      normalizedFullSha(currentHeadOid),
      ...commits.map((commit) => normalizedFullSha(commit.sha)),
      ...timeline
        .filter(({ event }) => event === "committed")
        .map(({ sha }) => normalizedFullSha(sha)),
      ...timeline
        .filter(({ event }) => event === "head_ref_force_pushed")
        .flatMap((event) => {
          const proof = provenForcePush(event);
          return proof.reason === null
            ? [proof.beforeHead, proof.afterHead]
            : [];
        }),
    ].filter(Boolean),
  );
  const seenRuns = new Set();
  const runSources = [
    ...issueComments.map((value) => ({ value, surface: "issue_comments" })),
    ...reviews.map((value) => ({ value, surface: "review_submissions" })),
  ];
  for (const { value, surface } of runSources) {
    const bot = botKeyForLogin(authorLogin(value));
    if (bot !== "coderabbit") continue;
    for (const runId of completedCodeRabbitReviewRunIds(value, surface)) {
      const key = `${bot}:${runId}`;
      if (seenRuns.has(key)) continue;
      seenRuns.add(key);
      evidence.reviewRuns.push({
        ...signalEvidence(value, { prUrl, type: "review_run", surface }),
        bot,
        runId,
      });
    }
  }

  for (const comment of issueComments) {
    if (botKeyForLogin(authorLogin(comment)) === "coderabbit") {
      for (const signal of detectedCodeRabbitSignals(comment)) {
        const record = signalEvidence(comment, { prUrl, type: signal });
        if (signal === "pause") evidence.pauses.push(record);
        if (signal === "rate_limit") evidence.rateLimits.push(record);
        if (signal === "path_filter_skip")
          evidence.pathFilterSkips.push(record);
        if (signal === "free_tier_notice")
          evidence.freeTierNotices.push(record);
      }
    }
    for (const target of requestTargets(comment.body)) {
      const marker = classifyRequestMarker(
        comment,
        target,
        knownHeads,
        timeline,
      );
      const record = {
        ...signalEvidence(comment, { prUrl, type: "manual_request" }),
        target,
        marker: marker.kind,
        markerReason: marker.reason,
        head: marker.head,
        effectiveHead: marker.effectiveHead,
        timelineCommentNodeId: marker.timelineCommentNodeId,
        timelineCommentIndex: marker.timelineCommentIndex,
      };
      if (!isTrustedRequestAuthor(comment)) {
        evidence.rejectedManualRequests.push({
          ...record,
          rejectedReason: "request_author_is_not_trusted",
        });
        continue;
      }
      evidence.manualRequests.push(record);
    }
  }

  return {
    reviewRuns: {
      count: evidence.reviewRuns.length,
      byBot: Object.fromEntries(
        REVIEW_BOT_KEYS.map((key) => [
          key,
          evidence.reviewRuns.filter(({ bot }) => bot === key).length,
        ]),
      ),
      evidence: evidence.reviewRuns,
    },
    pauses: { count: evidence.pauses.length, evidence: evidence.pauses },
    rateLimits: {
      count: evidence.rateLimits.length,
      evidence: evidence.rateLimits,
    },
    pathFilterSkips: {
      count: evidence.pathFilterSkips.length,
      evidence: evidence.pathFilterSkips,
    },
    freeTierNotices: {
      count: evidence.freeTierNotices.length,
      evidence: evidence.freeTierNotices,
    },
    manualRequests: summarizeManualRequests(
      evidence.manualRequests,
      evidence.rejectedManualRequests,
    ),
  };
}
