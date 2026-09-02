import {
  buildPerBotEvidence,
  REVIEW_BOT_KEYS,
} from "./review-process-metrics-core.mjs";
import { buildUnknownAttributionEvidence } from "./review-process-metrics-actions.mjs";
import {
  aggregateMetrics,
  summarizePullRequestMetrics,
} from "./review-process-metrics-legacy.mjs";
import { buildSignals } from "./review-process-metrics-signals.mjs";

const BOTS = REVIEW_BOT_KEYS;
const DISPOSITIONS = [
  "fixed",
  "wont_fix",
  "bot_conceded",
  "unclassified",
  "unknown",
];
const SURFACES = ["issue_comments", "review_submissions", "review_comments"];
const PAGINATED_SURFACES = [
  "issueComments",
  "reviewSubmissions",
  "reviewComments",
  "timeline",
  "commits",
];

function assertCompletePagination(pagination) {
  if (
    pagination == null ||
    PAGINATED_SURFACES.some(
      (surface) => pagination[surface]?.complete !== true,
    ) ||
    pagination.timeline?.forcePushGraphql?.complete !== true
  ) {
    throw new Error("schema-v2 metrics require complete pagination evidence");
  }
}

export function summarizePullRequestMetricsV2({
  pr,
  issueComments = [],
  reviews = [],
  reviewComments = [],
  timeline = [],
  commits = [],
  pagination,
  collectedAt = new Date().toISOString(),
}) {
  assertCompletePagination(pagination);
  const normalizedPr = {
    number: pr.number,
    title: pr.title,
    url: pr.html_url ?? pr.url,
    createdAt: pr.created_at ?? pr.createdAt,
    mergedAt: pr.merged_at ?? pr.mergedAt ?? null,
    changedFiles: pr.changed_files ?? pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    comments: issueComments,
    reviews,
    commits,
  };
  const summary = summarizePullRequestMetrics({
    pr: normalizedPr,
    reviewComments,
    collectedAt,
  });
  const prUrl = normalizedPr.url;
  const currentHeadOid = pr.head?.sha ?? pr.headOid ?? null;
  const prAuthorLogin = pr.user?.login ?? pr.author?.login ?? null;
  return {
    ...summary,
    headOid: currentHeadOid,
    collection: { complete: true, surfaces: pagination },
    evidence: {
      byBot: buildPerBotEvidence({
        prUrl,
        prAuthorLogin,
        issueComments,
        reviews,
        reviewComments,
      }),
      unknownAttribution: buildUnknownAttributionEvidence({
        prUrl,
        issueComments,
        reviews,
        reviewComments,
      }),
      signals: buildSignals({
        prUrl,
        currentHeadOid,
        commits,
        issueComments,
        reviews,
        timeline,
      }),
    },
  };
}

function emptyDispositionTotals() {
  return Object.fromEntries(DISPOSITIONS.map((category) => [category, 0]));
}

function emptyAggregateBot() {
  return {
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [surface, { records: 0, findings: 0 }]),
    ),
    dispositions: emptyDispositionTotals(),
  };
}

function aggregateBotEvidence(prs) {
  const byBot = Object.fromEntries(
    BOTS.map((bot) => [bot, emptyAggregateBot()]),
  );
  for (const pr of prs) {
    for (const bot of BOTS) {
      const source = pr.evidence.byBot[bot];
      const target = byBot[bot];
      for (const surface of SURFACES) {
        target.surfaces[surface].records += source.surfaces[surface].records;
        target.surfaces[surface].findings += source.surfaces[surface].findings;
      }
      for (const disposition of DISPOSITIONS) {
        target.dispositions[disposition] += source.dispositions[disposition];
      }
    }
  }
  return byBot;
}

function sum(prs, selector) {
  return prs.reduce((total, pr) => total + selector(pr), 0);
}

function aggregateSignals(prs) {
  const simple = ["pauses", "rateLimits", "pathFilterSkips", "freeTierNotices"];
  const result = Object.fromEntries(
    simple.map((key) => [
      key,
      { count: sum(prs, (pr) => pr.evidence.signals[key].count) },
    ]),
  );
  result.reviewRuns = {
    count: sum(prs, (pr) => pr.evidence.signals.reviewRuns.count),
    byBot: Object.fromEntries(
      BOTS.map((bot) => [
        bot,
        sum(prs, (pr) => pr.evidence.signals.reviewRuns.byBot[bot]),
      ]),
    ),
  };
  const requestEntries = prs.flatMap((pr) =>
    pr.evidence.signals.manualRequests.evidence.map((request) => ({
      prNumber: pr.number,
      request,
    })),
  );
  const requests = requestEntries.map(({ request }) => request);
  const rejectedRequests = prs.flatMap(
    (pr) => pr.evidence.signals.manualRequests.rejectedEvidence,
  );
  const headCounts = new Map();
  for (const { prNumber, request } of requestEntries) {
    if (request.marker !== "marked_exact_head") continue;
    const key = `${prNumber}:${request.head}`;
    headCounts.set(key, (headCounts.get(key) ?? 0) + 1);
  }
  result.manualRequests = {
    count: requests.length,
    markedExactHead: requests.filter(
      ({ marker }) => marker === "marked_exact_head",
    ).length,
    bare: requests.filter(({ marker }) => marker === "bare").length,
    unknown: requests.filter(({ marker }) => marker === "unknown").length,
    uniqueExactHeads: headCounts.size,
    duplicateExactHeadRequests: [...headCounts.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    byTarget: Object.fromEntries(
      BOTS.map((bot) => [
        bot,
        requests.filter(({ target }) => target === bot).length,
      ]),
    ),
    rejectedCount: rejectedRequests.length,
  };
  return result;
}

export function aggregateMetricsV2(prs) {
  return {
    ...aggregateMetrics(prs),
    evidence: {
      byBot: aggregateBotEvidence(prs),
      unknownAttribution: {
        count: sum(prs, (pr) => pr.evidence.unknownAttribution.count),
      },
      signals: aggregateSignals(prs),
    },
  };
}

export const REVIEW_PROCESS_METRICS_V2_CATEGORIES = Object.freeze({
  dispositions: [...DISPOSITIONS],
  surfaces: [...SURFACES],
  bots: [...BOTS],
});
