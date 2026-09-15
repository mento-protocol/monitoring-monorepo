#!/usr/bin/env node
/**
 * Summarize whether a GitHub pull request is ready for review-loop closure.
 *
 * Live mode shells out to `gh` only. The parsing helpers are exported so tests
 * can stay offline and fixture-driven.
 */

import { fileURLToPath } from "node:url";

import {
  checkDisplayName,
  isCodexReviewRequestBody,
  summarizeReadyState,
  summarizeTerminalReadyState,
} from "./pr-ready-state-core.mjs";
import {
  fetchHeadUpdatedAt,
  headUpdatedAtFromTimeline,
} from "./pr-ready-state-closeout.mjs";
import {
  findCodeRabbitPathFilterSkipCandidate,
  validateCodeRabbitPathFilterSkip,
} from "./pr-ready-state-review-signals.mjs";
import { formatCompact, formatHuman } from "./pr-ready-state-format.mjs";
import {
  fetchStackContext,
  verifyReadinessSnapshot,
} from "./pr-ready-state-stack.mjs";

import {
  ghJson,
  ghApiArgs,
  ghApiJsonPages,
  ghApiJsonResult,
  ghApiJsonPagesResult,
  splitRepo,
  repoPath,
} from "./pr-ready-state-gh.mjs";
import { fetchRequiredStatusContexts } from "./pr-ready-state-status-contexts.mjs";
import { fetchBaseBranchHealth } from "./pr-ready-state-base-health.mjs";

export { fetchHeadUpdatedAt, headUpdatedAtFromTimeline };
export { withGhAbortSignal } from "./pr-ready-state-gh.mjs";
export { splitRepo } from "./pr-ready-state-gh.mjs";
export {
  fetchRequiredStatusContexts,
  requiredStatusContextsFromProtection,
  requiredStatusContextsFromRules,
  requiredStatusContextsFromRulesResult,
  strictRequiredStatusChecksPolicyFromRules,
  workflowPathsFromRules,
} from "./pr-ready-state-status-contexts.mjs";
export { fetchBaseBranchHealth } from "./pr-ready-state-base-health.mjs";

export function repoFromPullRequestUrl(url) {
  try {
    const parsed = new URL(url);
    const [owner, name] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !name) return null;
    return {
      owner,
      name,
      host: parsed.hostname === "github.com" ? null : parsed.hostname,
    };
  } catch {
    return null;
  }
}

function appIdFromAvatarUrl(url) {
  const match = String(url ?? "").match(/\/in\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function latestStatusByContext(statuses = []) {
  const latest = new Map();
  for (const status of statuses) {
    if (!latest.has(status.context)) {
      latest.set(status.context, status);
    }
  }
  return latest;
}

function minIsoTimestamp(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

async function fetchStatusSourceMap({ repo, headSha }) {
  const path = repoPath(repo);
  const [checkRunsResult, statusesResult] = await Promise.all([
    ghApiJsonPagesResult(repo, [`repos/${path}/commits/${headSha}/check-runs`]),
    ghApiJsonPagesResult(repo, [`repos/${path}/commits/${headSha}/statuses`]),
  ]);

  const sourceMap = new Map();
  let observedAt = null;

  if (checkRunsResult.ok) {
    for (const page of checkRunsResult.value ?? []) {
      for (const checkRun of page.check_runs ?? []) {
        observedAt = minIsoTimestamp(
          observedAt,
          checkRun.created_at ?? checkRun.started_at,
        );
        if (
          checkRun.name &&
          checkRun.app?.id &&
          !sourceMap.has(checkRun.name)
        ) {
          sourceMap.set(checkRun.name, { appId: Number(checkRun.app.id) });
        }
      }
    }
  }

  if (statusesResult.ok) {
    for (const status of latestStatusByContext(statusesResult.value).values()) {
      observedAt = minIsoTimestamp(observedAt, status.created_at);
      const appId =
        appIdFromAvatarUrl(status.avatar_url) ??
        appIdFromAvatarUrl(status.creator?.avatar_url);
      if (status.context && appId !== null && !sourceMap.has(status.context)) {
        sourceMap.set(status.context, { appId });
      }
    }
  }

  return { sourceMap, observedAt };
}

function rollupAppId(check) {
  const value =
    check.appId ??
    check.app_id ??
    check.app?.id ??
    check.app?.databaseId ??
    null;
  return value === null || value === undefined ? null : Number(value);
}

export function annotateStatusCheckSources(statusCheckRollup, sourceMap) {
  return statusCheckRollup.map((check) => {
    if (rollupAppId(check) !== null) return check;
    const source = sourceMap.get(checkDisplayName(check));
    return source ? { ...check, ...source } : check;
  });
}

async function fetchReviewThreads({ repo, number }) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              comments(first: 10) {
                nodes {
                  id
                  url
                  body
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const threads = [];
  let cursor = null;
  for (;;) {
    const args = ghApiArgs(repo, [
      "graphql",
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${query}`,
    ]);
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }

    const data = await ghJson(args);

    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) return threads;
    threads.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) return threads;
    cursor = page.pageInfo.endCursor;
  }
}

async function attachCodexRequestReactions({ repo, issueComments }) {
  return Promise.all(
    issueComments.map(async (comment) => {
      if (!isCodexReviewRequestBody(comment.body)) return comment;
      const result = await ghApiJsonPagesResult(repo, [
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${repoPath(repo)}/issues/comments/${comment.id}/reactions`,
      ]);
      if (!result.ok) return comment;

      return {
        ...comment,
        reactions: result.value,
      };
    }),
  );
}

export async function fetchReadinessBases({
  repo,
  pr,
  fetchJson = ghApiJsonResult,
  fetchContexts = fetchRequiredStatusContexts,
  fetchBaseHealth = fetchBaseBranchHealth,
}) {
  const stack = await fetchStackContext({ repo, pr, fetchJson });
  const baseRef = stack?.protectionBaseRef ?? pr.baseRefName;
  const [requiredStatusContexts, baseHealth] = await Promise.all([
    fetchContexts({
      repo,
      baseRef,
      statusCheckRollup: pr.statusCheckRollup ?? [],
    }),
    // Thread the injected transport through, or an offline fixture would fall
    // back to the default and spawn a real `gh api graphql`.
    fetchBaseHealth({ repo, baseRef, fetchJson }),
  ]);
  return { stack, requiredStatusContexts, baseHealth };
}

export async function fetchReadyState({
  prArg,
  repoArg,
  includeFeedbackDetails = false,
}) {
  const prViewArgs = [
    "pr",
    "view",
    prArg,
    "--json",
    [
      "author",
      "autoMergeRequest",
      "baseRefName",
      "baseRefOid",
      "changedFiles",
      "headRefName",
      "headRefOid",
      "isDraft",
      "mergeable",
      "mergeStateStatus",
      "mergedAt",
      "number",
      "reviewDecision",
      "reviews",
      "state",
      "statusCheckRollup",
      "title",
      "url",
      "closedAt",
    ].join(","),
  ];

  if (repoArg) {
    prViewArgs.push("--repo", repoArg);
  }

  const pr = await ghJson(prViewArgs);

  const number = pr?.number;
  if (!number) {
    throw new Error(`Unable to resolve pull request: ${prArg}`);
  }

  const repo = repoFromPullRequestUrl(pr.url) ?? splitRepo(repoArg);
  const path = repoPath(repo);
  if (["MERGED", "CLOSED"].includes(String(pr.state ?? "").toUpperCase())) {
    return summarizeTerminalReadyState(pr);
  }

  const statusSourcePromise = fetchStatusSourceMap({
    repo,
    headSha: pr.headRefOid,
  });
  const issueCommentsPromise = ghApiJsonPages(repo, [
    `repos/${path}/issues/${number}/comments`,
  ]);
  const issueCommentsWithReactionsPromise = issueCommentsPromise.then(
    (issueComments) => attachCodexRequestReactions({ repo, issueComments }),
  );
  const reactionsPromise = ghApiJsonPages(repo, [
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${path}/issues/${number}/reactions`,
  ]);
  const reviewCommentsPromise = ghApiJsonPages(repo, [
    `repos/${path}/pulls/${number}/comments`,
  ]);
  const reviewThreadsPromise = fetchReviewThreads({ repo, number });
  const readinessBasesPromise = fetchReadinessBases({ repo, pr });
  const timelinePromise = ghApiJsonPagesResult(repo, [
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${path}/issues/${number}/timeline`,
  ]);

  const [
    { sourceMap, observedAt },
    issueComments,
    reactions,
    reviewComments,
    reviewThreads,
    { stack, requiredStatusContexts, baseHealth },
    timelineResult,
  ] = await Promise.all([
    statusSourcePromise,
    issueCommentsWithReactionsPromise,
    reactionsPromise,
    reviewCommentsPromise,
    reviewThreadsPromise,
    readinessBasesPromise,
    timelinePromise,
  ]);
  const headUpdatedAt = fetchHeadUpdatedAt({
    headSha: pr.headRefOid,
    timelineItems: timelineResult.ok ? timelineResult.value : [],
    observedAt,
  });
  const pathFilterCandidate = findCodeRabbitPathFilterSkipCandidate({
    issueComments,
    headUpdatedAt,
  });
  let codeRabbitPathFilterSkip = null;
  if (pathFilterCandidate) {
    const filesResult = await ghApiJsonPagesResult(repo, [
      `repos/${path}/pulls/${number}/files?per_page=100`,
    ]);
    const currentPrResult = filesResult.ok
      ? await ghApiJsonResult(repo, [`repos/${path}/pulls/${number}`])
      : { ok: false, value: null };
    const currentPr = currentPrResult.ok ? currentPrResult.value : null;
    codeRabbitPathFilterSkip = validateCodeRabbitPathFilterSkip({
      candidate: pathFilterCandidate,
      currentFiles: filesResult.ok
        ? filesResult.value.map((file) => file?.filename ?? null)
        : null,
      expectedChangedFileCount: pr.changedFiles,
      filesComplete:
        filesResult.ok &&
        currentPr?.head?.sha === pr.headRefOid &&
        currentPr?.changed_files === pr.changedFiles,
    });
  }
  await verifyReadinessSnapshot({
    repo,
    pr,
    stack,
    fetchJson: ghApiJsonResult,
  });
  const annotatedPr = {
    ...pr,
    headUpdatedAt,
    statusCheckRollup: annotateStatusCheckSources(
      pr.statusCheckRollup ?? [],
      sourceMap,
    ),
  };

  const summary = summarizeReadyState({
    pr: annotatedPr,
    issueComments,
    reactions,
    reviewComments,
    reviewThreads,
    requiredStatusContexts: requiredStatusContexts.contexts,
    requiredStatusContextsError: requiredStatusContexts.error,
    requiredStatusContextsAvailable: requiredStatusContexts.error === null,
    requiredStatusChecksStrict: requiredStatusContexts.strict ?? null,
    baseStatusCheckRollup: baseHealth?.rollup ?? [],
    baseHealthOid: baseHealth?.oid ?? null,
    baseHealthError: baseHealth?.error ?? null,
    includeFeedbackDetails,
    codeRabbitPathFilterSkip,
  });
  return stack
    ? {
        ...summary,
        pr: { ...summary.pr, baseRefOid: pr.baseRefOid },
        readinessScope: "layer",
        stack,
        summary: `Layer only: ${summary.summary} Stack readiness is not evaluated.`,
      }
    : summary;
}

function usage() {
  return `Usage: pnpm pr:ready-state <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n       pnpm pr:ready-state --pr <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n       pnpm pr:ready-state --help\n       node scripts/pr/pr-ready-state.mjs <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n\nNote: --watch --json emits newline-delimited JSON, one summary per poll. --until-ready only affects watch mode.\n`;
}

function readFlagValue(rest, flag) {
  const flagIndex = rest.indexOf(flag);
  if (flagIndex < 0) return undefined;

  const value = rest[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value\n${usage()}`);
  }

  rest.splice(flagIndex, 2);
  return value;
}

export function parseArgs(argv) {
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    return {
      help: true,
      json: false,
      compact: false,
      watch: false,
      untilReady: false,
      prArg: null,
      repoArg: null,
    };
  }

  const json = argv.includes("--json");
  const compact = argv.includes("--compact");
  const watch = argv.includes("--watch");
  const untilReady = argv.includes("--until-ready");
  const rest = argv.filter(
    (arg) => !["--json", "--compact", "--watch", "--until-ready"].includes(arg),
  );
  const repoArg = readFlagValue(rest, "--repo");
  let prArg = readFlagValue(rest, "--pr");
  if (!prArg) {
    prArg = rest[0];
    rest.splice(0, 1);
  }
  if (!prArg || rest.length > 0) {
    throw new Error(usage());
  }
  if (untilReady && !watch) {
    throw new Error("--until-ready requires --watch");
  }
  return { json, compact, watch, untilReady, prArg, repoArg };
}

export function renderSummary(summary, { json, compact, watch = false }) {
  if (json) return `${JSON.stringify(summary, null, watch ? 0 : 2)}\n`;
  if (compact) return `${formatCompact(summary)}\n`;
  return formatHuman(summary);
}

export function watchLoopExitCode(summary, { untilReady = false } = {}) {
  if (!untilReady) return null;

  const state = String(summary?.pr?.state ?? "").toUpperCase();
  if (summary?.ready === true || state === "MERGED") return 0;
  if (state === "CLOSED") return 1;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const { help, json, compact, watch, untilReady, prArg, repoArg } =
      parseArgs(process.argv.slice(2));
    if (help) {
      process.stdout.write(usage());
      return;
    }

    for (;;) {
      try {
        const summary = await fetchReadyState({ prArg, repoArg });
        process.stdout.write(renderSummary(summary, { json, compact, watch }));
        const exitCode = watchLoopExitCode(summary, { untilReady });
        if (watch && exitCode !== null) {
          process.exitCode = exitCode;
          return;
        }
      } catch (err) {
        if (!watch) throw err;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pr-ready-state] ${message}\n`);
      }
      if (!watch) return;
      await sleep(60_000);
    }
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    if (!String(err).endsWith("\n")) process.stderr.write("\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
