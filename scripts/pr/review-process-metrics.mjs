#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyClaudeActionsEvidence } from "./review-process-metrics-actions.mjs";
import {
  assertCompleteCohort,
  selectMergedAfter,
  selectMergedBefore,
  selectMergedInUtcWindow,
} from "./review-process-metrics-legacy.mjs";
import { writeReportFile } from "./review-process-metrics-output.mjs";
import {
  REVIEW_PROCESS_METRICS_V2_CATEGORIES,
  aggregateMetricsV2,
  summarizePullRequestMetricsV2,
} from "./review-process-metrics-report.mjs";
import { pullRequestEvidenceHeads } from "./review-process-metrics-signals.mjs";
import {
  assertCompleteForcePushGraphqlPages,
  assertEvidenceSnapshotStable,
  assertPullRequestMetadata,
  assertPullRequestSnapshotStable,
  enrichTimelineForcePushes,
  parseForcePushGraphqlPage,
} from "./review-process-metrics-timeline.mjs";

export * from "./review-process-metrics-actions.mjs";
export * from "./review-process-metrics-core.mjs";
export * from "./review-process-metrics-legacy.mjs";
export * from "./review-process-metrics-output.mjs";
export * from "./review-process-metrics-report.mjs";
export * from "./review-process-metrics-signals.mjs";
export * from "./review-process-metrics-timeline.mjs";

const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 100;
const PULL_REQUEST_COMMITS_LIMIT = 250;
const FORCE_PUSH_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){timelineItems(first:100,after:$cursor,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){totalCount pageInfo{hasNextPage endCursor} nodes{... on HeadRefForcePushedEvent{id createdAt beforeCommit{oid} afterCommit{oid}}}}}}}`;

function usage() {
  return `Usage: node scripts/pr/review-process-metrics.mjs [options]

Collect review-process metrics for merged cohorts or an explicit PR list.

Options:
  --repo <owner/repo>       GitHub repo. Default: ${DEFAULT_REPO}
  --prs <list>              Comma-separated PR numbers, including open PRs.
  --before-pr <number>      Select merged PRs before this PR's mergedAt.
  --after-pr <number>       Select merged PRs after this PR's mergedAt.
  --since <UTC timestamp>   Include PRs merged at or after this timestamp.
  --until <UTC timestamp>   Exclude PRs merged at or after this timestamp.
  --limit <number>          Cohort size with --before-pr/--after-pr. Default: ${DEFAULT_LIMIT}
  --output <path>           Write JSON to a file instead of stdout.
  -h, --help                Show this help.

--since and --until must be supplied together and define [since, until).
UTC timestamps must be RFC 3339 values ending in Z.
Unstructured finding prose classification fails closed above 256 labels or a 4,096-character labeled context.
`;
}

function parsePositiveInteger(value, name) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${name} requires a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} requires a safe positive integer`);
  }
  return parsed;
}

function parsePrList(value) {
  const numbers = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parsePositiveInteger(part, "--prs"));
  if (new Set(numbers).size !== numbers.length) {
    throw new Error("--prs must not contain duplicates");
  }
  return numbers;
}

export function parseUtcTimestamp(value, name) {
  const text = String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    text,
  );
  if (!match) {
    throw new Error(`${name} requires an RFC 3339 UTC timestamp ending in Z`);
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time))
    throw new Error(`${name} is not a valid timestamp`);
  const normalized = new Date(time).toISOString();
  const expected = `${match[1]}.${(match[2] ?? "").padEnd(3, "0") || "000"}Z`;
  if (normalized !== expected) {
    throw new Error(`${name} is not a valid timestamp`);
  }
  return normalized;
}

export function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    prs: [],
    beforePr: null,
    afterPr: null,
    since: null,
    until: null,
    limit: DEFAULT_LIMIT,
    limitProvided: false,
    output: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        args.repo = argv[++index] ?? "";
        if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(args.repo)) {
          throw new Error("--repo requires owner/repo");
        }
        break;
      case "--prs":
        args.prs = parsePrList(argv[++index] ?? "");
        if (args.prs.length === 0) throw new Error("--prs requires numbers");
        break;
      case "--before-pr":
        args.beforePr = parsePositiveInteger(argv[++index], "--before-pr");
        break;
      case "--after-pr":
        args.afterPr = parsePositiveInteger(argv[++index], "--after-pr");
        break;
      case "--since":
        args.since = parseUtcTimestamp(argv[++index], "--since");
        break;
      case "--until":
        args.until = parseUtcTimestamp(argv[++index], "--until");
        break;
      case "--limit":
        args.limit = parsePositiveInteger(argv[++index], "--limit");
        args.limitProvided = true;
        break;
      case "--output":
        args.output = argv[++index] ?? "";
        if (!args.output) throw new Error("--output requires a path");
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (args.help) return args;
  if ((args.since === null) !== (args.until === null)) {
    throw new Error("--since and --until must be supplied together");
  }
  if (args.since !== null && Date.parse(args.since) >= Date.parse(args.until)) {
    throw new Error("--since must be earlier than --until");
  }
  const selectors = [
    args.prs.length > 0,
    args.beforePr !== null,
    args.afterPr !== null,
    args.since !== null,
  ].filter(Boolean).length;
  if (selectors !== 1) {
    throw new Error(
      "provide exactly one of --prs, --before-pr, --after-pr, or --since/--until",
    );
  }
  if (args.limitProvided && args.beforePr === null && args.afterPr === null) {
    throw new Error("--limit applies only to --before-pr or --after-pr");
  }
  return args;
}

function ghJson(args) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`GitHub returned invalid JSON for: gh ${args.join(" ")}`);
  }
}

export function assertCompletePaginatedSurface(
  pages,
  { surface, expectedCount = null, sourceLimit = null, id = (item) => item.id },
) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`${surface} pagination returned no page envelope`);
  }
  if (pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${surface} pagination returned a non-array page`);
  }
  if (pages.slice(0, -1).some((page) => page.length === 0)) {
    throw new Error(
      `${surface} pagination returned an empty intermediate page`,
    );
  }
  const items = pages.flat();
  const identifiers = items.map(id);
  if (
    identifiers.some(
      (identifier) => identifier === null || identifier === undefined,
    )
  ) {
    throw new Error(
      `${surface} pagination returned an item without an identifier`,
    );
  }
  if (new Set(identifiers.map(String)).size !== identifiers.length) {
    throw new Error(`${surface} pagination returned duplicate items`);
  }
  if (expectedCount !== null && items.length !== expectedCount) {
    const limitReason =
      sourceLimit !== null && expectedCount > sourceLimit
        ? `; the GitHub endpoint caps this surface at ${sourceLimit} items`
        : "";
    throw new Error(
      `${surface} pagination is incomplete: expected ${expectedCount}, received ${items.length}${limitReason}`,
    );
  }
  return {
    items,
    pagination: {
      complete: true,
      proof:
        expectedCount === null
          ? "gh_api_followed_all_next_links"
          : "gh_api_followed_all_next_links_and_count_matched",
      pages: pages.length,
      itemCount: items.length,
      expectedCount,
      sourceLimit,
      pageSize: PAGE_SIZE,
    },
  };
}

export function timelineItemIdentity(item) {
  const nodeId =
    typeof item?.node_id === "string" && item.node_id.length > 0
      ? item.node_id
      : null;
  if (nodeId !== null) return JSON.stringify(["node", nodeId]);

  const sourceNodeId =
    typeof item?.source?.issue?.node_id === "string" &&
    item.source.issue.node_id.length > 0
      ? item.source.issue.node_id
      : null;
  const createdAt =
    typeof item?.created_at === "string" && item.created_at.length > 0
      ? item.created_at
      : null;
  if (
    item?.event === "cross-referenced" &&
    sourceNodeId !== null &&
    createdAt !== null
  ) {
    return JSON.stringify(["cross-referenced", sourceNodeId, createdAt]);
  }
  return null;
}

function fetchPaginated(repo, endpoint, options) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const pages = ghJson([
    "api",
    `repos/${repo}/${endpoint}${separator}per_page=${PAGE_SIZE}`,
    "--paginate",
    "--slurp",
  ]);
  return assertCompletePaginatedSurface(pages, options);
}

function fetchForcePushes(repo, number) {
  const [owner, name] = repo.split("/");
  const pages = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${FORCE_PUSH_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const page = parseForcePushGraphqlPage(ghJson(args), cursor);
    pages.push(page);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor !== null && seenCursors.has(cursor)) {
      throw new Error(`PR #${number} force-push pagination repeated a cursor`);
    }
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);
  return assertCompleteForcePushGraphqlPages(
    pages,
    `PR #${number} force-push timeline`,
  );
}

function mapPullRequestFromRest(pr) {
  return {
    number: pr.number,
    title: pr.title,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    url: pr.html_url,
  };
}

function fetchMergedPrList(repo) {
  return fetchPaginated(
    repo,
    "pulls?state=closed&sort=created&direction=desc",
    { surface: "merged_pull_request_list", id: (pr) => pr.number },
  )
    .items.filter((pr) => pr.merged_at)
    .map(mapPullRequestFromRest);
}
function fetchPrMetadata(repo, number, options) {
  const pr = ghJson(["api", `repos/${repo}/pulls/${number}`]);
  return assertPullRequestMetadata(pr, number, options);
}

function fetchEvidenceSurfaces(repo, number, pr) {
  const issueComments = fetchPaginated(repo, `issues/${number}/comments`, {
    surface: `PR #${number} issue comments`,
    expectedCount: pr.comments,
  });
  const reviews = fetchPaginated(repo, `pulls/${number}/reviews`, {
    surface: `PR #${number} review submissions`,
  });
  const reviewComments = fetchPaginated(repo, `pulls/${number}/comments`, {
    surface: `PR #${number} review comments`,
    expectedCount: pr.review_comments,
  });
  const timeline = fetchPaginated(repo, `issues/${number}/timeline`, {
    surface: `PR #${number} timeline`,
    id: timelineItemIdentity,
  });
  const commits = fetchPaginated(repo, `pulls/${number}/commits`, {
    surface: `PR #${number} commits`,
    expectedCount: pr.commits,
    sourceLimit: PULL_REQUEST_COMMITS_LIMIT,
    id: (commit) => commit.sha,
  });
  return { issueComments, reviews, reviewComments, timeline, commits };
}

function fetchPrEvidence(repo, number, collectedAt, options) {
  const pr = fetchPrMetadata(repo, number, options);
  const surfaces = fetchEvidenceSurfaces(repo, number, pr);
  const { issueComments, reviews, reviewComments, timeline, commits } =
    surfaces;
  const restForcePushCount = timeline.items.filter(
    ({ event }) => event === "head_ref_force_pushed",
  ).length;
  const forcePushes =
    restForcePushCount === 0
      ? {
          items: [],
          pagination: {
            complete: true,
            proof: "complete_rest_timeline_proves_empty_force_push_set",
            pages: 0,
            itemCount: 0,
            expectedCount: 0,
            source: "rest",
          },
        }
      : fetchForcePushes(repo, number);
  const enrichedTimeline = enrichTimelineForcePushes(
    timeline.items,
    forcePushes.items,
  );
  if (!enrichedTimeline.complete) {
    throw new Error(
      `PR #${number} force-push proof conflicts with the REST timeline: ${JSON.stringify(enrichedTimeline.conflicts)}`,
    );
  }
  verifyClaudeActionsEvidence(
    [issueComments.items, reviews.items, reviewComments.items],
    {
      repo,
      prNumber: number,
      prUrl: pr.html_url,
      headRepository: pr.head?.repo?.full_name,
      headRef: pr.head?.ref,
      headShas: pullRequestEvidenceHeads(
        pr,
        commits.items,
        enrichedTimeline.items,
      ),
      verifiedAt: collectedAt,
      fetchRun: (runId) =>
        ghJson(["api", `repos/${repo}/actions/runs/${runId}`]),
      fetchPullRequestsByHead: (owner, headRef) =>
        fetchPaginated(
          repo,
          `pulls?state=all&head=${encodeURIComponent(`${owner}:${headRef}`)}`,
          {
            surface: `PR #${number} Claude Actions head lookup`,
            id: (pullRequest) => pullRequest.number,
          },
        ).items,
      beforeFinalize: () => {
        assertEvidenceSnapshotStable(
          surfaces,
          fetchEvidenceSurfaces(repo, number, pr),
          number,
        );
        assertPullRequestSnapshotStable(
          pr,
          fetchPrMetadata(repo, number, options),
          number,
        );
      },
    },
  );
  return summarizePullRequestMetricsV2({
    pr,
    issueComments: issueComments.items,
    reviews: reviews.items,
    reviewComments: reviewComments.items,
    timeline: enrichedTimeline.items,
    commits: commits.items,
    pagination: {
      issueComments: issueComments.pagination,
      reviewSubmissions: reviews.pagination,
      reviewComments: reviewComments.pagination,
      timeline: {
        ...timeline.pagination,
        forcePushGraphql: {
          ...forcePushes.pagination,
          expectedCount: restForcePushCount,
          restTimelineItemCount: restForcePushCount,
          bindingProof:
            "one_to_one_node_id_and_timestamp_with_rest_commit_cross_check_when_present",
        },
      },
      commits: commits.pagination,
    },
    collectedAt,
  });
}

function fetchBoundary(repo, number) {
  return mapPullRequestFromRest(
    fetchPrMetadata(repo, number, { requireMerged: true }),
  );
}

function resolveCohort(args) {
  if (args.prs.length > 0) {
    return {
      mode: "explicit",
      pullRequests: args.prs.map((number) => ({ number })),
    };
  }
  const list = fetchMergedPrList(args.repo);
  if (args.since !== null) {
    return {
      mode: "utc-window",
      since: args.since,
      until: args.until,
      pullRequests: selectMergedInUtcWindow(list, args.since, args.until),
    };
  }
  const boundary = fetchBoundary(args.repo, args.beforePr ?? args.afterPr);
  const cohort =
    args.beforePr !== null
      ? selectMergedBefore(list, boundary.mergedAt, args.limit)
      : selectMergedAfter(list, boundary.mergedAt, args.limit);
  assertCompleteCohort(cohort, {
    direction: args.beforePr !== null ? "before" : "after",
    limit: args.limit,
    boundary,
  });
  return {
    mode: args.beforePr !== null ? "before-pr" : "after-pr",
    beforePr: args.beforePr !== null ? boundary : null,
    afterPr: args.afterPr !== null ? boundary : null,
    pullRequests: cohort,
  };
}

export function buildReport({ args, cohort, pullRequests, collectedAt }) {
  return {
    schemaVersion: 2,
    repo: args.repo,
    collectedAt,
    collection: {
      complete: pullRequests.every((pr) => pr.collection.complete),
      paginationPolicy:
        "Every REST list follows all next links. Available GitHub counts must match exactly.",
    },
    cohort: {
      mode: cohort.mode,
      boundary:
        cohort.mode === "utc-window"
          ? {
              since: cohort.since,
              until: cohort.until,
              interval: "[since, until)",
            }
          : null,
      beforePr: cohort.beforePr ?? null,
      afterPr: cohort.afterPr ?? null,
      limit:
        cohort.mode === "before-pr" || cohort.mode === "after-pr"
          ? args.limit
          : null,
      pullRequestNumbers: pullRequests.map((pr) => pr.number),
    },
    summary: aggregateMetricsV2(pullRequests),
    pullRequests,
    classification: {
      humanRepliesAreAuthoritative: true,
      categories: REVIEW_PROCESS_METRICS_V2_CATEGORIES.dispositions,
      unknownPolicy:
        "Use unknown for conflicting or insufficient evidence. Unclassified means no human classification was present.",
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const collectedAt = new Date().toISOString();
  const cohort = resolveCohort(args);
  const requireMerged = cohort.mode !== "explicit";
  const pullRequests = cohort.pullRequests.map(({ number }, index) => {
    process.stderr.write(
      `Collecting PR #${number} (${index + 1}/${cohort.pullRequests.length})\n`,
    );
    return fetchPrEvidence(args.repo, number, collectedAt, { requireMerged });
  });
  const output = `${JSON.stringify(
    buildReport({ args, cohort, pullRequests, collectedAt }),
    null,
    2,
  )}\n`;
  if (args.output) writeReportFile(args.output, output);
  else process.stdout.write(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
