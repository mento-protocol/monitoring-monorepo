import {
  REVIEW_BOT_KEYS,
  authorLogin,
  baseEvidence,
  botKeyForLogin,
  isTrustedRequestAuthor,
} from "./review-process-metrics-core.mjs";

function extractRunIds(body) {
  return [
    ...String(body ?? "").matchAll(
      /\*\*Run ID\*\*:\s*`?([0-9a-f][0-9a-f-]{7,})`?/gi,
    ),
  ].map((match) => match[1].toLowerCase());
}

function signalEvidence(value, { prUrl, type, surface = "issue_comments" }) {
  return {
    ...baseEvidence(value, { prUrl, surface }),
    type,
  };
}

function detectedCodeRabbitSignals(comment) {
  const body = String(comment.body ?? "");
  const signals = [];
  if (
    /auto-generated comment:\s*review paused by coderabbit\.ai/i.test(body) &&
    /##\s*Reviews paused/i.test(body)
  ) {
    signals.push("pause");
  }
  if (
    /auto-generated comment:\s*rate limited by coderabbit\.ai/i.test(body) &&
    /##\s*Review limit reached/i.test(body)
  ) {
    signals.push("rate_limit");
  }
  if (
    /auto-generated comment:\s*skip review by coderabbit\.ai/i.test(body) &&
    /Review was skipped due to path filters/i.test(body)
  ) {
    signals.push("path_filter_skip");
  }
  if (
    /auto-generated comment:\s*skip review by coderabbit\.ai/i.test(body) &&
    /does not receive automatic reviews because it has fewer than 10 stars/i.test(
      body,
    )
  ) {
    signals.push("free_tier_notice");
  }
  return signals;
}

function requestTargets(body) {
  const text = String(body ?? "");
  return [
    ["coderabbit", /(?:^|\n)\s*@coderabbitai\s+review\s*(?:\n|$)/i],
    ["codex", /(?:^|\n)\s*@codex\s+review\s*(?:\n|$)/i],
    ["claude", /(?:^|\n)\s*@claude\s+review\s*(?:\n|$)/i],
    ["cursor", /(?:^|\n)\s*bugbot\s+run\s*(?:\n|$)/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([target]) => target);
}

function classifyRequestMarker(body, target, knownHeads) {
  const text = String(body ?? "");
  const markerStarts = [
    ...text.matchAll(/<!--\s*coderabbit-final-head-review:/gi),
  ];
  if (target !== "coderabbit" || markerStarts.length === 0) {
    return { kind: "bare", head: null, reason: null };
  }
  const heads = [
    ...text.matchAll(
      /<!--\s*coderabbit-final-head-review:([0-9a-f]{40})\s*-->/gi,
    ),
  ].map((match) => match[1].toLowerCase());
  if (markerStarts.length !== 1 || heads.length !== 1) {
    return { kind: "unknown", head: null, reason: "malformed_head_marker" };
  }
  const head = heads[0];
  if (!knownHeads.has(head)) {
    return { kind: "unknown", head, reason: "head_not_in_pr_history" };
  }
  return { kind: "marked_exact_head", head, reason: null };
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
    [currentHeadOid, ...commits.map((commit) => commit.sha)]
      .filter(Boolean)
      .map((head) => String(head).toLowerCase()),
  );
  const seenRuns = new Set();
  const runSources = [
    ...issueComments.map((value) => ({ value, surface: "issue_comments" })),
    ...reviews.map((value) => ({ value, surface: "review_submissions" })),
  ];
  for (const { value, surface } of runSources) {
    const bot = botKeyForLogin(authorLogin(value));
    if (bot !== "coderabbit") continue;
    for (const runId of extractRunIds(value.body)) {
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
      const marker = classifyRequestMarker(comment.body, target, knownHeads);
      const record = {
        ...signalEvidence(comment, { prUrl, type: "manual_request" }),
        target,
        marker: marker.kind,
        markerReason: marker.reason,
        head: marker.head,
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
