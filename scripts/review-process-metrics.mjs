#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
const DEFAULT_LIMIT = 20;
const REVIEW_BOT_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
  "claude",
  "claude[bot]",
  "cursor",
  "cursor[bot]",
]);

function usage() {
  return `Usage: node scripts/review-process-metrics.mjs [options]

Collect review-process metrics for merged PR cohorts.

Options:
  --repo <owner/repo>       GitHub repo. Default: ${DEFAULT_REPO}
  --prs <list>              Comma-separated PR numbers to collect.
  --before-pr <number>      Select merged PRs before this PR's mergedAt.
  --after-pr <number>       Select merged PRs after this PR's mergedAt.
  --limit <number>          Cohort size with --before-pr. Default: ${DEFAULT_LIMIT}
  --output <path>           Write JSON to a file instead of stdout.
  -h, --help                Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    prs: [],
    beforePr: null,
    afterPr: null,
    limit: DEFAULT_LIMIT,
    output: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        args.repo = argv[++index] ?? "";
        if (!args.repo) throw new Error("--repo requires owner/repo");
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
      case "--limit":
        args.limit = parsePositiveInteger(argv[++index], "--limit");
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

  const cohortSelectors = [
    args.prs.length > 0,
    args.beforePr !== null,
    args.afterPr !== null,
  ].filter(Boolean).length;
  if (!args.help && cohortSelectors > 1) {
    throw new Error("use only one of --prs, --before-pr, or --after-pr");
  }
  if (!args.help && cohortSelectors === 0) {
    throw new Error("provide --prs, --before-pr, or --after-pr");
  }

  return args;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return parsed;
}

function parsePrList(value) {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parsePositiveInteger(part, "--prs"));
}

function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
    }),
  );
}

function flattenGhPages(value) {
  if (!Array.isArray(value)) return [];
  return value.every((entry) => Array.isArray(entry)) ? value.flat() : value;
}

function timestamp(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function hoursBetween(start, end) {
  const startTime = timestamp(start);
  const endTime = timestamp(end);
  if (startTime === null || endTime === null) return null;
  return Math.round(((endTime - startTime) / 3_600_000) * 100) / 100;
}

function authorLogin(value) {
  return String(value?.author?.login ?? value?.user?.login ?? "").toLowerCase();
}

export function isReviewBotLogin(login) {
  return REVIEW_BOT_LOGINS.has(String(login ?? "").toLowerCase());
}

export function isFindingLikeText(value) {
  const body = String(value ?? "");
  return (
    /\[[Pp][0-3]\]/.test(body) ||
    /\b[Pp][0-3]\s+Badge\b/.test(body) ||
    /\bBUGBOT_BUG_ID\b/.test(body) ||
    /\bchanges requested\b/i.test(body) ||
    /\b(?:critical|high|medium|low) severity\b/i.test(body) ||
    /\bfindings?\b/i.test(body)
  );
}

function isReviewRequest(value) {
  return /@(codex|claude)\s+review\b/i.test(String(value ?? ""));
}

function isCodexUsageLimit(value) {
  return /codex usage limits have been reached/i.test(String(value ?? ""));
}

function isCodexApprovalComment(value) {
  return /codex review:\s+did(?:n['’]?t| not) find any major issues/i.test(
    String(value ?? ""),
  );
}

function isClaudeSummary(value) {
  return /claude finished|pr review:/i.test(String(value ?? ""));
}

function uniqueRootReviewComments(reviewComments) {
  return reviewComments.filter((comment) => comment.in_reply_to_id == null);
}

function reviewCommentReplyCount(reviewComments) {
  return reviewComments.filter((comment) => comment.in_reply_to_id != null)
    .length;
}

function rootReviewCommentsWithoutReplies(reviewComments) {
  const repliedRootIds = new Set(
    reviewComments
      .map((comment) => comment.in_reply_to_id)
      .filter((id) => id !== null && id !== undefined),
  );
  return uniqueRootReviewComments(reviewComments).filter(
    (comment) => !repliedRootIds.has(comment.id),
  );
}

function earliestReviewTimestamp({
  issueComments = [],
  reviewComments = [],
  reviews = [],
}) {
  const candidates = [];
  for (const comment of issueComments) {
    if (
      isReviewBotLogin(authorLogin(comment)) ||
      isReviewRequest(comment.body)
    ) {
      candidates.push(timestamp(comment.createdAt ?? comment.created_at));
    }
  }
  for (const comment of reviewComments) {
    candidates.push(timestamp(comment.created_at ?? comment.createdAt));
  }
  for (const review of reviews) {
    candidates.push(timestamp(review.submittedAt ?? review.submitted_at));
  }
  const finite = candidates.filter((time) => time !== null);
  return finite.length === 0 ? null : Math.min(...finite);
}

function countCommitsAfter(commits, cutoff) {
  if (cutoff === null) return null;
  return commits.filter((commit) => {
    const committedAt = timestamp(
      commit.committedDate ?? commit.commit?.committer?.date,
    );
    return committedAt !== null && committedAt > cutoff;
  }).length;
}

export function selectMergedBefore(prs, beforeMergedAt, limit = DEFAULT_LIMIT) {
  const cutoff = timestamp(beforeMergedAt);
  if (cutoff === null) throw new Error("beforeMergedAt must be a timestamp");
  return [...prs]
    .filter((pr) => {
      const mergedAt = timestamp(pr.mergedAt);
      return mergedAt !== null && mergedAt < cutoff;
    })
    .sort((a, b) => timestamp(b.mergedAt) - timestamp(a.mergedAt))
    .slice(0, limit);
}

export function selectMergedAfter(prs, afterMergedAt, limit = DEFAULT_LIMIT) {
  const cutoff = timestamp(afterMergedAt);
  if (cutoff === null) throw new Error("afterMergedAt must be a timestamp");
  return [...prs]
    .filter((pr) => {
      const mergedAt = timestamp(pr.mergedAt);
      return mergedAt !== null && mergedAt > cutoff;
    })
    .sort((a, b) => timestamp(a.mergedAt) - timestamp(b.mergedAt))
    .slice(0, limit);
}

export function summarizePullRequestMetrics({
  pr,
  reviewComments = [],
  collectedAt = new Date().toISOString(),
}) {
  const issueComments = pr.comments ?? [];
  const reviews = pr.reviews ?? [];
  const commits = pr.commits ?? [];
  const rootReviewComments = uniqueRootReviewComments(reviewComments);
  const firstReviewAt = earliestReviewTimestamp({
    issueComments,
    reviewComments,
    reviews,
  });
  const reviewBotTopLevel = issueComments.filter((comment) =>
    isReviewBotLogin(authorLogin(comment)),
  );
  const reviewBotInlineRoots = rootReviewComments.filter((comment) =>
    isReviewBotLogin(authorLogin(comment)),
  );
  const humanReviewRequests = issueComments.filter(
    (comment) =>
      !isReviewBotLogin(authorLogin(comment)) && isReviewRequest(comment.body),
  );
  const findingLikeTopLevel = issueComments.filter(
    (comment) =>
      isReviewBotLogin(authorLogin(comment)) && isFindingLikeText(comment.body),
  );
  const findingLikeInline = rootReviewComments.filter((comment) =>
    isFindingLikeText(comment.body),
  );
  const claudeTopLevel = issueComments.filter(
    (comment) =>
      authorLogin(comment) === "claude" && isClaudeSummary(comment.body),
  );
  const codexTopLevel = issueComments.filter(
    (comment) => authorLogin(comment) === "chatgpt-codex-connector",
  );

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    collectedAt,
    durationHours: hoursBetween(pr.createdAt, pr.mergedAt),
    changedFiles: pr.changedFiles ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    commits: commits.length,
    commitsAfterFirstReview: countCommitsAfter(commits, firstReviewAt),
    reviews: {
      submissions: reviews.length,
      byBots: reviews.filter((review) => isReviewBotLogin(authorLogin(review)))
        .length,
      byHumans: reviews.filter(
        (review) => !isReviewBotLogin(authorLogin(review)),
      ).length,
    },
    comments: {
      topLevel: issueComments.length,
      reviewInlineRoots: rootReviewComments.length,
      reviewInlineReplies: reviewCommentReplyCount(reviewComments),
      reviewInlineRootsWithoutReplies:
        rootReviewCommentsWithoutReplies(reviewComments).length,
      humanReviewRequests: humanReviewRequests.length,
    },
    botReviewSignals: {
      topLevelReviewBotComments: reviewBotTopLevel.length,
      inlineReviewBotRoots: reviewBotInlineRoots.length,
      findingLikeTopLevel: findingLikeTopLevel.length,
      findingLikeInline: findingLikeInline.length,
      candidateFindings: findingLikeTopLevel.length + findingLikeInline.length,
      codexComments: codexTopLevel.length,
      codexUsageLimitComments: issueComments.filter((comment) =>
        isCodexUsageLimit(comment.body),
      ).length,
      codexApprovalComments: issueComments.filter((comment) =>
        isCodexApprovalComment(comment.body),
      ).length,
      claudeSummaryComments: claudeTopLevel.length,
    },
  };
}

function numericValues(prs, selector) {
  return prs
    .map(selector)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function median(values) {
  if (values.length === 0) return null;
  const midpoint = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[midpoint];
  return (
    Math.round(((values[midpoint - 1] + values[midpoint]) / 2) * 100) / 100
  );
}

function sum(prs, selector) {
  return prs.reduce((total, pr) => {
    const value = selector(pr);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

export function aggregateMetrics(prs) {
  return {
    pullRequests: prs.length,
    medianDurationHours: median(numericValues(prs, (pr) => pr.durationHours)),
    medianCommitsAfterFirstReview: median(
      numericValues(prs, (pr) => pr.commitsAfterFirstReview),
    ),
    totals: {
      comments: sum(prs, (pr) => pr.comments.topLevel),
      inlineReviewRoots: sum(prs, (pr) => pr.comments.reviewInlineRoots),
      inlineReviewReplies: sum(prs, (pr) => pr.comments.reviewInlineReplies),
      inlineRootsWithoutReplies: sum(
        prs,
        (pr) => pr.comments.reviewInlineRootsWithoutReplies,
      ),
      humanReviewRequests: sum(prs, (pr) => pr.comments.humanReviewRequests),
      candidateFindings: sum(
        prs,
        (pr) => pr.botReviewSignals.candidateFindings,
      ),
      codexUsageLimitComments: sum(
        prs,
        (pr) => pr.botReviewSignals.codexUsageLimitComments,
      ),
      codexApprovalComments: sum(
        prs,
        (pr) => pr.botReviewSignals.codexApprovalComments,
      ),
      claudeSummaryComments: sum(
        prs,
        (pr) => pr.botReviewSignals.claudeSummaryComments,
      ),
    },
  };
}

function fetchMergedPrList(repo, limit) {
  return ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--limit",
    String(limit),
    "--json",
    "number,title,createdAt,mergedAt,url",
  ]);
}

function fetchPrView(repo, number) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    [
      "number",
      "title",
      "url",
      "createdAt",
      "mergedAt",
      "additions",
      "deletions",
      "changedFiles",
      "commits",
      "comments",
      "reviews",
    ].join(","),
  ]);
}

function fetchReviewComments(repo, number) {
  return flattenGhPages(
    ghJson([
      "api",
      `repos/${repo}/pulls/${number}/comments`,
      "--paginate",
      "--slurp",
    ]),
  );
}

function resolveCohort(args) {
  if (args.prs.length > 0) {
    return {
      mode: "explicit",
      pullRequests: args.prs.map((number) => ({ number })),
    };
  }

  const boundary = ghJson([
    "pr",
    "view",
    String(args.beforePr ?? args.afterPr),
    "--repo",
    args.repo,
    "--json",
    "number,title,mergedAt,url",
  ]);
  const list = fetchMergedPrList(args.repo, Math.max(args.limit * 5, 100));
  const cohort =
    args.beforePr !== null
      ? selectMergedBefore(list, boundary.mergedAt, args.limit)
      : selectMergedAfter(list, boundary.mergedAt, args.limit);
  return {
    mode: args.beforePr !== null ? "before-pr" : "after-pr",
    beforePr: args.beforePr !== null ? boundary : null,
    afterPr: args.afterPr !== null ? boundary : null,
    pullRequests: cohort,
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
  const pullRequests = cohort.pullRequests.map(({ number }) => {
    const pr = fetchPrView(args.repo, number);
    const reviewComments = fetchReviewComments(args.repo, number);
    return summarizePullRequestMetrics({ pr, reviewComments, collectedAt });
  });
  const report = {
    schemaVersion: 1,
    repo: args.repo,
    collectedAt,
    cohort: {
      mode: cohort.mode,
      beforePr: cohort.beforePr ?? null,
      afterPr: cohort.afterPr ?? null,
      limit: args.limit,
      pullRequestNumbers: pullRequests.map((pr) => pr.number),
    },
    summary: aggregateMetrics(pullRequests),
    pullRequests,
    manualClassification: {
      required: true,
      note: "candidateFindings counts finding-like review comments. Classify each candidate as accepted, valid-wont-fix, duplicate-stale, or noise before comparing review quality.",
      categories: ["accepted", "valid-wont-fix", "duplicate-stale", "noise"],
    },
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, output);
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
