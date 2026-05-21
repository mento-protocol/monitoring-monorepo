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

export function requiredStatusContextsFromRules(rules = []) {
  return [
    ...new Set(
      rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context)
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
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
      const rulesResult = ghApiJsonResult(repo, [
        `repos/${repoPath(repo)}/rules/branches/${encodedBaseRef}`,
      ]);

      if (!rulesResult.ok) {
        return {
          contexts: [],
          error: rulesResult.error,
        };
      }

      return {
        contexts: requiredStatusContextsFromRules(rulesResult.value ?? []),
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
    pr,
    issueComments,
    reactions,
    reviewComments,
    reviewThreads,
    requiredStatusContexts: requiredStatusContexts.contexts,
    requiredStatusContextsError: requiredStatusContexts.error,
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
