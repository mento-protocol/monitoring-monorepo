#!/usr/bin/env node
/**
 * Summarize whether a GitHub pull request is ready for review-loop closure.
 *
 * Live mode shells out to `gh` only. The parsing helpers are exported so tests
 * can stay offline and fixture-driven.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkDisplayName,
  isCodexReviewRequestBody,
  summarizeReadyState,
  summarizeTerminalReadyState,
} from "./pr-ready-state-core.mjs";
import { formatCompact, formatHuman } from "./pr-ready-state-format.mjs";

const GH_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;

    function fail(message) {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new Error(message));
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stdout exceeded ${GH_OUTPUT_MAX_BYTES} byte limit`,
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stderr exceeded ${GH_OUTPUT_MAX_BYTES} byte limit`,
        );
        return;
      }
      stderr += chunk;
    });
    child.on("error", (err) => {
      fail(`gh ${args.join(" ")} failed: ${err.message}`);
    });
    child.on("close", (status) => {
      if (failed) return;
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}

async function ghJson(args) {
  const stdout = await runGh(args);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function ghApiArgs(repo, args) {
  const ghArgs = ["api"];
  if (repo.host) {
    ghArgs.push("--hostname", repo.host);
  }
  ghArgs.push(...args);
  return ghArgs;
}

async function ghApiJsonPages(repo, args) {
  const parsed = await ghJson([
    ...ghApiArgs(repo, args),
    "--paginate",
    "--slurp",
  ]);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

async function ghApiJsonResult(repo, args) {
  try {
    const stdout = await runGh(ghApiArgs(repo, args));
    return {
      ok: true,
      value: stdout.trim() ? JSON.parse(stdout) : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ghApiJsonPagesResult(repo, args) {
  try {
    const stdout = await runGh([
      ...ghApiArgs(repo, args),
      "--paginate",
      "--slurp",
    ]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return {
      ok: true,
      value: Array.isArray(parsed)
        ? parsed.flatMap((page) => (Array.isArray(page) ? page : [page]))
        : [],
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function addRequiredContext(byKey, context, integrationId = null) {
  if (!context) return;
  const normalizedIntegrationId =
    integrationId === null || integrationId === undefined
      ? null
      : Number(integrationId);
  const key = `${context}\0${normalizedIntegrationId ?? ""}`;
  byKey.set(key, {
    context,
    integrationId: normalizedIntegrationId,
  });
}

function workflowPath(workflow) {
  return (
    workflow.path ??
    workflow.workflow_path ??
    workflow.workflowPath ??
    workflow.file_path ??
    workflow.filePath ??
    null
  );
}

function workflowRepoPath(workflow, rule, fallbackRepoPath = null) {
  const explicitRepo =
    workflow.repository_full_name ??
    workflow.repositoryFullName ??
    workflow.repository?.full_name ??
    workflow.repository?.fullName ??
    workflow.repository_name ??
    workflow.repositoryName ??
    null;
  if (explicitRepo && String(explicitRepo).includes("/")) {
    return String(explicitRepo);
  }

  if (
    rule?.ruleset_source_type === "Repository" &&
    rule?.ruleset_source &&
    String(rule.ruleset_source).includes("/")
  ) {
    return String(rule.ruleset_source);
  }

  if (rule?.ruleset_source_type) {
    return null;
  }

  return fallbackRepoPath;
}

function workflowLookupKey(repoPathValue, path) {
  return repoPathValue && path ? `${repoPathValue}\0${path}` : null;
}

function flattenRules(rules = [], inherited = {}) {
  const flattened = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const current = {
      ...inherited,
      ...rule,
    };
    if (rule.type) flattened.push(current);
    flattened.push(
      ...flattenRules(rule.rules ?? [], {
        ruleset_source: current.ruleset_source,
        ruleset_source_type: current.ruleset_source_type,
      }),
    );
  }
  return flattened;
}

export function workflowPathsFromRules(rules = []) {
  const paths = new Set();
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      if (path) paths.add(path);
    }
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

function workflowRepoPathsFromRules(rules = [], fallbackRepoPath = null) {
  const repoPaths = new Set();
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      const repoPathValue = workflowRepoPath(workflow, rule, fallbackRepoPath);
      if (path && repoPathValue) repoPaths.add(repoPathValue);
    }
  }

  return [...repoPaths].sort((a, b) => a.localeCompare(b));
}

function unresolvedWorkflowSourcesFromRules(
  rules = [],
  fallbackRepoPath = null,
) {
  const unresolved = [];
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      if (!path) continue;
      if (workflowRepoPath(workflow, rule, fallbackRepoPath) === null) {
        unresolved.push(path);
      }
    }
  }

  return unresolved;
}

function requiredWorkflowContext(
  workflow,
  rule,
  workflowNameByPath,
  fallbackRepoPath = null,
) {
  const path = workflowPath(workflow);
  const repoPathValue = workflowRepoPath(workflow, rule, fallbackRepoPath);
  const keyedName = workflowNameByPath.get(
    workflowLookupKey(repoPathValue, path),
  );
  return (
    workflow.name ??
    workflow.workflow_name ??
    workflow.workflowName ??
    keyedName ??
    (path ? workflowNameByPath.get(path) : null) ??
    null
  );
}

function requiredWorkflowJobContexts({
  workflow,
  rule,
  workflowNameByPath,
  fallbackRepoPath,
  statusCheckRollup,
}) {
  const workflowName = requiredWorkflowContext(
    workflow,
    rule,
    workflowNameByPath,
    fallbackRepoPath,
  );
  if (!workflowName) return [];

  const matchingJobNames = statusCheckRollup
    .filter((check) => check.workflowName === workflowName)
    .map(checkDisplayName);
  return matchingJobNames.length > 0 ? matchingJobNames : [workflowName];
}

export function requiredStatusContextsFromRules(
  rules = [],
  {
    workflowNameByPath = new Map(),
    fallbackRepoPath = null,
    statusCheckRollup = [],
  } = {},
) {
  const byKey = new Map();
  for (const rule of flattenRules(rules)) {
    if (rule.type === "required_status_checks") {
      for (const check of rule.parameters?.required_status_checks ?? []) {
        addRequiredContext(
          byKey,
          check.context,
          check.integration_id ?? check.integrationId ?? null,
        );
      }
      continue;
    }

    if (rule.type === "workflows") {
      for (const workflow of rule.parameters?.workflows ?? []) {
        for (const context of requiredWorkflowJobContexts({
          workflow,
          rule,
          workflowNameByPath,
          fallbackRepoPath,
          statusCheckRollup,
        })) {
          addRequiredContext(
            byKey,
            context,
            workflow.integration_id ?? workflow.integrationId ?? null,
          );
        }
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.context.localeCompare(b.context));
}

export function requiredStatusContextsFromRulesResult(
  rules = [],
  {
    workflowNameByPath = new Map(),
    workflowNameLookupError = null,
    fallbackRepoPath = null,
    statusCheckRollup = [],
  } = {},
) {
  const unresolvedSources =
    fallbackRepoPath === null
      ? []
      : unresolvedWorkflowSourcesFromRules(rules, fallbackRepoPath);
  if (unresolvedSources.length > 0) {
    return {
      contexts: [],
      error: `Unable to resolve source repository for required workflow(s): ${unresolvedSources.join(", ")}`,
    };
  }

  if (workflowPathsFromRules(rules).length > 0 && workflowNameLookupError) {
    return { contexts: [], error: workflowNameLookupError };
  }

  return {
    contexts: requiredStatusContextsFromRules(rules, {
      workflowNameByPath,
      fallbackRepoPath,
      statusCheckRollup,
    }),
    error: null,
  };
}

export function requiredStatusContextsFromProtection(protection) {
  if (Array.isArray(protection)) return protection;

  const byKey = new Map();
  for (const check of protection?.checks ?? []) {
    addRequiredContext(
      byKey,
      check.context,
      check.app_id ?? check.appId ?? null,
    );
  }

  if (byKey.size === 0) {
    for (const context of protection?.contexts ?? []) {
      addRequiredContext(byKey, context);
    }
  }

  return [...byKey.values()].sort((a, b) => a.context.localeCompare(b.context));
}

export function splitRepo(repoValue) {
  const parts = String(repoValue).split("/").filter(Boolean);
  const name = parts.pop();
  const owner = parts.pop();
  if (!owner || !name) {
    throw new Error(`Unable to parse repository name: ${repoValue}`);
  }
  const host = parts.length > 0 ? parts.join("/") : null;
  return { owner, name, host };
}

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

function repoPath(repo) {
  return `${repo.owner}/${repo.name}`;
}

function repoFromPath(path, host = null) {
  const { owner, name } = splitRepo(path);
  return { owner, name, host };
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

async function fetchWorkflowNameByPath(repo, pathKey = repoPath(repo)) {
  const result = await ghApiJsonPagesResult(repo, [
    `repos/${repoPath(repo)}/actions/workflows?per_page=100`,
  ]);
  const byPath = new Map();
  if (!result.ok) return { byPath, error: result.error };

  for (const page of result.value ?? []) {
    for (const workflow of page.workflows ?? []) {
      if (workflow.path && workflow.name) {
        byPath.set(workflowLookupKey(pathKey, workflow.path), workflow.name);
        byPath.set(workflow.path, workflow.name);
      }
    }
  }

  return { byPath, error: null };
}

async function fetchWorkflowNamesForRules(repo, rules) {
  const fallbackRepoPath = repoPath(repo);
  const byPath = new Map();
  const unresolvedSources = unresolvedWorkflowSourcesFromRules(
    rules,
    fallbackRepoPath,
  );

  if (unresolvedSources.length > 0) {
    return {
      byPath: new Map(),
      error: `Unable to resolve source repository for required workflow(s): ${unresolvedSources.join(", ")}`,
    };
  }

  const results = await Promise.all(
    workflowRepoPathsFromRules(rules, fallbackRepoPath).map(
      async (sourcePath) => {
        const sourceRepo = repoFromPath(sourcePath, repo.host);
        return fetchWorkflowNameByPath(sourceRepo, sourcePath);
      },
    ),
  );

  for (const result of results) {
    if (result.error) return { byPath: new Map(), error: result.error };
    for (const [key, value] of result.byPath.entries()) {
      byPath.set(key, value);
    }
  }

  return { byPath, error: null };
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

function validIsoTimestamp(value) {
  return Number.isFinite(Date.parse(value ?? "")) ? value : null;
}

function timelineEventTimestamp(item) {
  return (
    validIsoTimestamp(item?.created_at) ??
    validIsoTimestamp(item?.submitted_at) ??
    validIsoTimestamp(item?.updated_at) ??
    null
  );
}

export function headUpdatedAtFromTimeline(timelineItems = [], headSha) {
  const normalizedHeadSha = String(headSha ?? "").toLowerCase();
  if (!normalizedHeadSha) return null;

  let headCommitIndex = -1;
  let headCommitTimestamp = null;
  for (const [index, item] of timelineItems.entries()) {
    if (
      item?.event === "committed" &&
      String(item.sha ?? "").toLowerCase() === normalizedHeadSha
    ) {
      headCommitIndex = index;
      headCommitTimestamp = timelineEventTimestamp(item);
    }
  }
  if (headCommitIndex < 0) return null;
  if (headCommitTimestamp) return headCommitTimestamp;

  for (const item of timelineItems.slice(headCommitIndex + 1)) {
    const timestamp = timelineEventTimestamp(item);
    if (timestamp) return timestamp;
  }
  return null;
}

export function fetchHeadUpdatedAt({ headSha, timelineItems, observedAt }) {
  return minIsoTimestamp(
    headUpdatedAtFromTimeline(timelineItems, headSha),
    validIsoTimestamp(observedAt),
  );
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

async function fetchRequiredStatusContexts({
  repo,
  baseRef,
  statusCheckRollup = [],
}) {
  const encodedBaseRef = encodeURIComponent(baseRef);
  const result = await ghApiJsonResult(repo, [
    `repos/${repoPath(repo)}/branches/${encodedBaseRef}/protection/required_status_checks`,
  ]);

  if (!result.ok) {
    if (result.error.includes("Branch not protected (HTTP 404)")) {
      const rulesResult = await ghApiJsonPagesResult(repo, [
        `repos/${repoPath(repo)}/rules/branches/${encodedBaseRef}`,
      ]);

      if (!rulesResult.ok) {
        return {
          contexts: [],
          error: rulesResult.error,
        };
      }

      const workflowNameByPath = workflowPathsFromRules(rulesResult.value ?? [])
        .length
        ? await fetchWorkflowNamesForRules(repo, rulesResult.value ?? [])
        : { byPath: new Map(), error: null };

      return requiredStatusContextsFromRulesResult(rulesResult.value ?? [], {
        workflowNameByPath: workflowNameByPath.byPath,
        workflowNameLookupError: workflowNameByPath.error,
        fallbackRepoPath: repoPath(repo),
        statusCheckRollup,
      });
    }

    return {
      contexts: [],
      error: result.error,
    };
  }

  return {
    contexts: requiredStatusContextsFromProtection(result.value),
    error: null,
  };
}

export async function fetchReadyState({ prArg, repoArg }) {
  const prViewArgs = [
    "pr",
    "view",
    prArg,
    "--json",
    [
      "author",
      "baseRefName",
      "headRefName",
      "headRefOid",
      "isDraft",
      "mergeable",
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
  const requiredStatusContextsPromise = fetchRequiredStatusContexts({
    repo,
    baseRef: pr.baseRefName,
    statusCheckRollup: pr.statusCheckRollup ?? [],
  });
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
    requiredStatusContexts,
    timelineResult,
  ] = await Promise.all([
    statusSourcePromise,
    issueCommentsWithReactionsPromise,
    reactionsPromise,
    reviewCommentsPromise,
    reviewThreadsPromise,
    requiredStatusContextsPromise,
    timelinePromise,
  ]);
  const headUpdatedAt = fetchHeadUpdatedAt({
    headSha: pr.headRefOid,
    timelineItems: timelineResult.ok ? timelineResult.value : [],
    observedAt,
  });
  const annotatedPr = {
    ...pr,
    headUpdatedAt,
    statusCheckRollup: annotateStatusCheckSources(
      pr.statusCheckRollup ?? [],
      sourceMap,
    ),
  };

  return summarizeReadyState({
    pr: annotatedPr,
    issueComments,
    reactions,
    reviewComments,
    reviewThreads,
    requiredStatusContexts: requiredStatusContexts.contexts,
    requiredStatusContextsError: requiredStatusContexts.error,
    requiredStatusContextsAvailable: requiredStatusContexts.error === null,
  });
}

function usage() {
  return `Usage: pnpm pr:ready-state <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n       pnpm pr:ready-state --pr <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n       pnpm pr:ready-state --help\n       node scripts/pr-ready-state.mjs <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]\n\nNote: --watch --json emits newline-delimited JSON, one summary per poll. --until-ready only affects watch mode.\n`;
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
