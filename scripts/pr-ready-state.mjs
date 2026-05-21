#!/usr/bin/env node
/**
 * Summarize whether a GitHub pull request is ready for review-loop closure.
 *
 * Live mode shells out to `gh` only. The parsing helpers are exported so tests
 * can stay offline and fixture-driven.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { summarizeReadyState } from "./pr-ready-state-core.mjs";
import { formatHuman } from "./pr-ready-state-format.mjs";

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed with exit ${result.status}:\n${result.stderr}`,
    );
  }

  return result.stdout;
}

function ghJson(args) {
  const stdout = runGh(args);
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

function ghApiJsonPages(repo, args) {
  const parsed = ghJson([...ghApiArgs(repo, args), "--paginate", "--slurp"]);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function ghApiJsonResult(repo, args) {
  const result = spawnSync("gh", ghApiArgs(repo, args), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `exit ${result.status}`,
    };
  }

  try {
    return {
      ok: true,
      value: result.stdout.trim() ? JSON.parse(result.stdout) : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function ghApiJsonPagesResult(repo, args) {
  const result = spawnSync(
    "gh",
    [...ghApiArgs(repo, args), "--paginate", "--slurp"],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `exit ${result.status}`,
    };
  }

  try {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
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

export function workflowPathsFromRules(rules = []) {
  const paths = new Set();
  for (const rule of rules) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      if (path) paths.add(path);
    }
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

function requiredWorkflowContext(workflow, workflowNameByPath) {
  const path = workflowPath(workflow);
  return (
    workflow.name ??
    workflow.workflow_name ??
    workflow.workflowName ??
    (path ? workflowNameByPath.get(path) : null) ??
    null
  );
}

export function requiredStatusContextsFromRules(
  rules = [],
  { workflowNameByPath = new Map() } = {},
) {
  const byKey = new Map();
  for (const rule of rules) {
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
        addRequiredContext(
          byKey,
          requiredWorkflowContext(workflow, workflowNameByPath),
          workflow.integration_id ?? workflow.integrationId ?? null,
        );
      }
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

function fetchStatusSourceMap({ repo, headSha }) {
  const path = repoPath(repo);
  const checkRunsResult = ghApiJsonPagesResult(repo, [
    `repos/${path}/commits/${headSha}/check-runs`,
  ]);
  const statusesResult = ghApiJsonPagesResult(repo, [
    `repos/${path}/commits/${headSha}/statuses`,
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
        if (checkRun.name && checkRun.app?.id) {
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
      if (status.context && appId !== null) {
        sourceMap.set(status.context, { appId });
      }
    }
  }

  return { sourceMap, observedAt };
}

function fetchWorkflowNameByPath(repo) {
  const result = ghApiJsonPagesResult(repo, [
    `repos/${repoPath(repo)}/actions/workflows?per_page=100`,
  ]);
  const byPath = new Map();
  if (!result.ok) return byPath;

  for (const page of result.value ?? []) {
    for (const workflow of page.workflows ?? []) {
      if (workflow.path && workflow.name) {
        byPath.set(workflow.path, workflow.name);
      }
    }
  }

  return byPath;
}

function statusCheckName(check) {
  return (
    check.name ??
    check.context ??
    check.workflowName ??
    check.app?.name ??
    check.__typename ??
    "unknown check"
  );
}

function annotateStatusCheckSources(statusCheckRollup, sourceMap) {
  return statusCheckRollup.map((check) => {
    const source = sourceMap.get(statusCheckName(check));
    return source ? { ...check, ...source } : check;
  });
}

function fetchHeadPushedAt({ repo, headSha }) {
  const query = `
    query($owner: String!, $name: String!, $oid: GitObjectID!) {
      repository(owner: $owner, name: $name) {
        object(oid: $oid) {
          ... on Commit {
            pushedDate
          }
        }
      }
    }
  `;
  const result = ghApiJsonResult(repo, [
    "graphql",
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
    "-f",
    `oid=${headSha}`,
    "-f",
    `query=${query}`,
  ]);
  if (!result.ok) return null;

  return result.value?.data?.repository?.object?.pushedDate ?? null;
}

function fetchHeadUpdatedAt({ repo, headSha, observedAt }) {
  return fetchHeadPushedAt({ repo, headSha }) ?? observedAt ?? null;
}

function fetchReviewThreads({ repo, number }) {
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

    const data = ghJson(args);

    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) return threads;
    threads.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) return threads;
    cursor = page.pageInfo.endCursor;
  }
}

function fetchRequiredStatusContexts({ repo, baseRef }) {
  const encodedBaseRef = encodeURIComponent(baseRef);
  const result = ghApiJsonResult(repo, [
    `repos/${repoPath(repo)}/branches/${encodedBaseRef}/protection/required_status_checks/contexts`,
  ]);

  if (!result.ok) {
    if (result.error.includes("Branch not protected (HTTP 404)")) {
      const rulesResult = ghApiJsonPagesResult(repo, [
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
        ? fetchWorkflowNameByPath(repo)
        : new Map();

      return {
        contexts: requiredStatusContextsFromRules(rulesResult.value ?? [], {
          workflowNameByPath,
        }),
        error: null,
      };
    }

    return {
      contexts: [],
      error: result.error,
    };
  }

  return {
    contexts: Array.isArray(result.value) ? result.value : [],
    error: null,
  };
}

function fetchReadyState({ prArg, repoArg }) {
  const prViewArgs = [
    "pr",
    "view",
    prArg,
    "--json",
    [
      "author",
      "baseRefName",
      "commits",
      "headRefName",
      "headRefOid",
      "isDraft",
      "mergeable",
      "number",
      "reviewDecision",
      "reviews",
      "statusCheckRollup",
      "title",
      "url",
    ].join(","),
  ];

  if (repoArg) {
    prViewArgs.push("--repo", repoArg);
  }

  const pr = ghJson(prViewArgs);

  const number = pr?.number;
  if (!number) {
    throw new Error(`Unable to resolve pull request: ${prArg}`);
  }

  const repo = repoFromPullRequestUrl(pr.url) ?? splitRepo(repoArg);
  const path = repoPath(repo);
  const { sourceMap, observedAt } = fetchStatusSourceMap({
    repo,
    headSha: pr.headRefOid,
  });
  const headUpdatedAt = fetchHeadUpdatedAt({
    repo,
    headSha: pr.headRefOid,
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

  const issueComments = ghApiJsonPages(repo, [
    `repos/${path}/issues/${number}/comments`,
  ]);
  const reactions = ghApiJsonPages(repo, [
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${path}/issues/${number}/reactions`,
  ]);
  const reviewComments = ghApiJsonPages(repo, [
    `repos/${path}/pulls/${number}/comments`,
  ]);
  const reviewThreads = fetchReviewThreads({ repo, number });
  const requiredStatusContexts = fetchRequiredStatusContexts({
    repo,
    baseRef: pr.baseRefName,
  });

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
  return `Usage: pnpm pr:ready-state <pr-number-or-url> [--repo <[host/]owner/name>] [--json]\n       pnpm pr:ready-state --pr <pr-number-or-url> [--repo <[host/]owner/name>] [--json]\n       pnpm pr:ready-state --help\n       node scripts/pr-ready-state.mjs <pr-number-or-url> [--repo <[host/]owner/name>] [--json]\n`;
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
  if (help) return { help: true, json: false, prArg: null, repoArg: null };

  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  const repoArg = readFlagValue(rest, "--repo");
  let prArg = readFlagValue(rest, "--pr");
  if (!prArg) {
    prArg = rest[0];
    rest.splice(0, 1);
  }
  if (!prArg || rest.length > 0) {
    throw new Error(usage());
  }
  return { json, prArg, repoArg };
}

function main() {
  try {
    const { help, json, prArg, repoArg } = parseArgs(process.argv.slice(2));
    if (help) {
      process.stdout.write(usage());
      return;
    }
    const summary = fetchReadyState({ prArg, repoArg });
    process.stdout.write(
      json ? `${JSON.stringify(summary, null, 2)}\n` : formatHuman(summary),
    );
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    if (!String(err).endsWith("\n")) process.stderr.write("\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
