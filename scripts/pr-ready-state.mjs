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

function ghApiJsonPages(args) {
  const parsed = ghJson(["api", ...args, "--paginate", "--slurp"]);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function ghApiJsonOptional(args, fallback) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0 || result.error) {
    return fallback;
  }

  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : fallback;
  } catch {
    return fallback;
  }
}

function splitRepo(nameWithOwner) {
  const [owner, name] = String(nameWithOwner).split("/");
  if (!owner || !name) {
    throw new Error(`Unable to parse repository name: ${nameWithOwner}`);
  }
  return { owner, name };
}

async function fetchReviewThreads({ owner, name, number }) {
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
    const args = [
      "api",
      "graphql",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${query}`,
    ];
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

function fetchRequiredStatusContexts({ owner, name, baseRef }) {
  const contexts = ghApiJsonOptional(
    [
      `repos/${owner}/${name}/branches/${baseRef}/protection/required_status_checks/contexts`,
    ],
    [],
  );
  return Array.isArray(contexts) ? contexts : [];
}

async function fetchReadyState({ prArg, repoArg }) {
  const repoInfo = repoArg
    ? { nameWithOwner: repoArg }
    : ghJson(["repo", "view", "--json", "nameWithOwner"]);
  const nameWithOwner = repoInfo?.nameWithOwner;
  const { owner, name } = splitRepo(nameWithOwner);
  const repoPath = `${owner}/${name}`;

  const pr = ghJson([
    "pr",
    "view",
    prArg,
    "--json",
    [
      "baseRefName",
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
  ]);

  const number = pr?.number;
  if (!number) {
    throw new Error(`Unable to resolve pull request: ${prArg}`);
  }

  const issueComments = ghApiJsonPages([
    `repos/${repoPath}/issues/${number}/comments`,
  ]);
  const reactions = ghApiJsonPages([
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${repoPath}/issues/${number}/reactions`,
  ]);
  const reviewComments = ghApiJsonPages([
    `repos/${repoPath}/pulls/${number}/comments`,
  ]);
  const reviewThreads = await fetchReviewThreads({ owner, name, number });
  const requiredStatusContexts = fetchRequiredStatusContexts({
    owner,
    name,
    baseRef: pr.baseRefName,
  });

  return summarizeReadyState({
    pr,
    issueComments,
    reactions,
    reviewComments,
    reviewThreads,
    requiredStatusContexts,
  });
}

function usage() {
  return `Usage: pnpm pr:ready-state <pr-number-or-url> [--repo <owner/name>] [--json]\n       pnpm pr:ready-state --pr <pr-number-or-url> [--repo <owner/name>] [--json]\n       node scripts/pr-ready-state.mjs <pr-number-or-url> [--repo <owner/name>] [--json]\n`;
}

function parseArgs(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  const repoFlagIndex = rest.indexOf("--repo");
  let repoArg;
  if (repoFlagIndex >= 0) {
    repoArg = rest[repoFlagIndex + 1];
    rest.splice(repoFlagIndex, 2);
  }
  const prFlagIndex = rest.indexOf("--pr");
  let prArg;
  if (prFlagIndex >= 0) {
    prArg = rest[prFlagIndex + 1];
    rest.splice(prFlagIndex, 2);
  }
  if (!prArg) {
    prArg = rest[0];
    rest.splice(0, 1);
  }
  if (!prArg || rest.length > 0) {
    throw new Error(usage());
  }
  return { json, prArg, repoArg };
}

async function main() {
  try {
    const { json, prArg, repoArg } = parseArgs(process.argv.slice(2));
    const summary = await fetchReadyState({ prArg, repoArg });
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
  await main();
}
