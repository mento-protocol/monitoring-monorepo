#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertCompleteCohort,
  selectMergedAfter,
  selectMergedBefore,
  selectMergedInUtcWindow,
} from "./review-process-metrics-legacy.mjs";
import {
  REVIEW_PROCESS_METRICS_V2_CATEGORIES,
  aggregateMetricsV2,
  summarizePullRequestMetricsV2,
} from "./review-process-metrics-report.mjs";

export * from "./review-process-metrics-core.mjs";
export * from "./review-process-metrics-legacy.mjs";
export * from "./review-process-metrics-report.mjs";
export * from "./review-process-metrics-signals.mjs";

const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 100;

function usage() {
  return `Usage: node scripts/pr/review-process-metrics.mjs [options]

Collect review-process metrics for merged PR cohorts.

Options:
  --repo <owner/repo>       GitHub repo. Default: ${DEFAULT_REPO}
  --prs <list>              Comma-separated PR numbers to collect.
  --before-pr <number>      Select merged PRs before this PR's mergedAt.
  --after-pr <number>       Select merged PRs after this PR's mergedAt.
  --since <UTC timestamp>   Include PRs merged at or after this timestamp.
  --until <UTC timestamp>   Exclude PRs merged at or after this timestamp.
  --limit <number>          Cohort size with --before-pr/--after-pr. Default: ${DEFAULT_LIMIT}
  --output <path>           Write JSON to a file instead of stdout.
  -h, --help                Show this help.

--since and --until must be supplied together and define [since, until).
UTC timestamps must be RFC 3339 values ending in Z.
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
        if (!/^[^/\s]+\/[^/\s]+$/.test(args.repo)) {
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
  { surface, expectedCount = null, id = (item) => item.id },
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
    throw new Error(
      `${surface} pagination is incomplete: expected ${expectedCount}, received ${items.length}`,
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
      pageSize: PAGE_SIZE,
    },
  };
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

function fetchPrMetadata(repo, number) {
  const pr = ghJson(["api", `repos/${repo}/pulls/${number}`]);
  if (pr.number !== number) {
    throw new Error(`pull request metadata mismatch for #${number}`);
  }
  if (!pr.merged_at) throw new Error(`pull request #${number} is not merged`);
  return pr;
}

function fetchPrEvidence(repo, number, collectedAt) {
  const pr = fetchPrMetadata(repo, number);
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
  const commits = fetchPaginated(repo, `pulls/${number}/commits`, {
    surface: `PR #${number} commits`,
    expectedCount: pr.commits,
    id: (commit) => commit.sha,
  });
  return summarizePullRequestMetricsV2({
    pr,
    issueComments: issueComments.items,
    reviews: reviews.items,
    reviewComments: reviewComments.items,
    commits: commits.items,
    pagination: {
      issueComments: issueComments.pagination,
      reviewSubmissions: reviews.pagination,
      reviewComments: reviewComments.pagination,
      commits: commits.pagination,
    },
    collectedAt,
  });
}

function fetchBoundary(repo, number) {
  return mapPullRequestFromRest(fetchPrMetadata(repo, number));
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

export function writeReportFile(path, output) {
  writeFileSync(path, output, { flag: "wx", mode: 0o600 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const collectedAt = new Date().toISOString();
  const cohort = resolveCohort(args);
  const pullRequests = cohort.pullRequests.map(({ number }, index) => {
    process.stderr.write(
      `Collecting PR #${number} (${index + 1}/${cohort.pullRequests.length})\n`,
    );
    return fetchPrEvidence(args.repo, number, collectedAt);
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
