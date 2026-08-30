/**
 * `gh` and GraphQL transport for the issue board.
 *
 * Every subprocess the board runs lives here: the bounded `gh` runner, the
 * JSON and GraphQL wrappers over it, the issue readers, and the git branch
 * probe. Nothing above this layer spawns a child process.
 */

import { spawn } from "node:child_process";

import {
  labelNames,
  labelsForState,
  pinnedGithubCliEnvironment,
  splitRepo,
  validateOpenPr,
} from "./issue-board-state.mjs";

const GH_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
// A bounded traversal must fail rather than use an incomplete comment history.
export const MAX_ISSUE_COMMENT_PAGES = 100;
export const MAX_ISSUE_COMMENT_NODES = 10_000;

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@#-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatGh(args) {
  return `gh ${args.map((arg) => quoteArg(String(arg))).join(" ")}`;
}

export function githubProjectScopeHint(stderr, env = process.env, args = []) {
  const requiredScopes = String(stderr).match(
    /requires one of the following scopes?\s*:\s*\[([^\r\n]{0,240}?)\]/i,
  )?.[1];
  const lockApi = args.some((arg) => {
    const value = String(arg);
    return (
      /\/git\/(?:commits|refs)(?:\/|$)/.test(value) ||
      /\bupdateRefs\b/.test(value)
    );
  });
  if (
    !lockApi &&
    (!requiredScopes || !/\b(?:read:project|project)\b/i.test(requiredScopes))
  ) {
    return "";
  }
  const credentialGuidance =
    env.GH_TOKEN || env.GITHUB_TOKEN
      ? "Replace the environment-provided GH_TOKEN or GITHUB_TOKEN with one carrying read/write `project` and repository Contents write access; `gh auth refresh` does not update environment-provided tokens."
      : "Refresh it with: gh auth refresh -h github.com -s project -s repo";
  return [
    "GitHub issue-board mutations require the active gh credential's read/write `project` scope and repository Contents write access.",
    credentialGuidance,
    "`read:project` alone and repository Contents read alone cannot run claim, review, release, sync, or backfill mutations.",
  ].join("\n");
}

export function runGh(args, { dryRun = false, mutates = false } = {}) {
  const env = pinnedGithubCliEnvironment(process.env);
  if (dryRun && mutates) {
    process.stderr.write(`[dry-run] ${formatGh(args)}\n`);
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env,
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
          `gh ${args.join(" ")} stdout exceeded ${GH_OUTPUT_MAX_BYTES} bytes`,
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stderr exceeded ${GH_OUTPUT_MAX_BYTES} bytes`,
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
        const scopeHint = githubProjectScopeHint(stderr, process.env, args);
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}${scopeHint ? `\n${scopeHint}\n` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export async function editIssueLabels(options, issue, state) {
  const transition = labelsForState(state);
  const existingLabels = labelNames(issue);
  const addLabels = transition.addLabels.filter(
    (label) => !existingLabels.has(label),
  );
  const removeLabels = transition.removeLabels.filter((label) =>
    existingLabels.has(label),
  );
  if (addLabels.length === 0 && removeLabels.length === 0) return;

  const args = ["issue", "edit", String(issue.number), "-R", options.repo];
  if (addLabels.length > 0) {
    args.push("--add-label", addLabels.join(","));
  }
  if (removeLabels.length > 0) {
    args.push("--remove-label", removeLabels.join(","));
  }
  await runGh(args, { dryRun: options.dryRun, mutates: true });
}

export async function addIssueLabels(options, issue, labels) {
  const existingLabels = labelNames(issue);
  const addLabels = labels.filter((label) => !existingLabels.has(label));
  if (addLabels.length === 0) return;

  await runGh(
    [
      "issue",
      "edit",
      String(issue.number),
      "-R",
      options.repo,
      "--add-label",
      addLabels.join(","),
    ],
    { dryRun: options.dryRun, mutates: true },
  );
}

export async function removeIssueLabels(options, issue, labels) {
  const existingLabels = labelNames(issue);
  const removeLabels = labels.filter((label) => existingLabels.has(label));
  if (removeLabels.length === 0) return;

  await runGh(
    [
      "issue",
      "edit",
      String(issue.number),
      "-R",
      options.repo,
      "--remove-label",
      removeLabels.join(","),
    ],
    { dryRun: options.dryRun, mutates: true },
  );
}

export async function commentOnIssue(options, issue, body) {
  if (!options.comment) return;
  await runGh(
    [
      "issue",
      "comment",
      String(issue.number),
      "-R",
      options.repo,
      "--body",
      body,
    ],
    { dryRun: options.dryRun, mutates: true },
  );
}

export async function ghJson(args, opts = {}) {
  const stdout = await runGh(args, opts);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function ghGraphql(query, variables = {}, opts = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value == null) continue;
    const flag = typeof value === "number" ? "-F" : "-f";
    args.push(flag, `${key}=${value}`);
  }
  return ghJson(args, opts);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function getGitBranch() {
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn("git", ["branch", "--show-current"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve(output);
        else reject(new Error(error));
      });
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function listReadyIssues(options) {
  const search =
    "is:issue is:open label:agent-ready -label:agent-active -label:in-pr";
  const issues = await ghJson([
    "issue",
    "list",
    "-R",
    options.repo,
    "--search",
    search,
    "--limit",
    String(options.count),
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
  return issues ?? [];
}

export async function listIssuesByLabels(
  options,
  labels,
  { state = "open", json = ghJson } = {},
) {
  const stateQualifier = state === "all" ? "" : ` is:${state}`;
  const issues = await json([
    "issue",
    "list",
    "-R",
    options.repo,
    "--state",
    state,
    "--search",
    `is:issue${stateQualifier} label:${labels.join(",")}`,
    "--limit",
    "1000",
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
  return issues ?? [];
}

export async function getIssue(
  options,
  number,
  { json = ghJson, graphql = ghGraphql } = {},
) {
  const issue = await json([
    "issue",
    "view",
    String(number),
    "-R",
    options.repo,
    "--json",
    "id,number,title,url,labels,state,body,projectItems",
  ]);
  if (!issue?.id) {
    throw new Error(`Issue #${number} lookup returned no node ID`);
  }
  const response = await graphql(
    `
      query ($issue: ID!) {
        node(id: $issue) {
          ... on Issue {
            blockedBy(first: 1) {
              totalCount
              nodes {
                id
              }
            }
            projectItems(first: 50) {
              nodes {
                id
                project {
                  id
                  title
                }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    optionId
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { issue: issue.id },
  );
  const blockedBy = response?.data?.node?.blockedBy;
  if (
    !blockedBy ||
    !Number.isInteger(blockedBy.totalCount) ||
    !Array.isArray(blockedBy.nodes)
  ) {
    throw new Error(
      `Issue #${number} blocked-by lookup returned an incomplete relationship`,
    );
  }
  const projectItems = response?.data?.node?.projectItems;
  if (
    !Array.isArray(projectItems?.nodes) ||
    projectItems?.pageInfo?.hasNextPage !== false
  ) {
    throw new Error(
      `Issue #${number} Project item lookup returned an incomplete page`,
    );
  }
  const exactProjectItems = projectItems.nodes.map((item) => ({
    id: item?.id ?? null,
    title: item?.project?.title ?? null,
    project: {
      id: item?.project?.id ?? null,
      title: item?.project?.title ?? null,
    },
    status: item?.fieldValueByName
      ? {
          name: item.fieldValueByName.name ?? null,
          optionId: item.fieldValueByName.optionId ?? null,
          fieldId: item.fieldValueByName.field?.id ?? null,
        }
      : null,
  }));
  return {
    ...issue,
    blockedBy,
    projectItems: exactProjectItems,
    projectItemsPageInfo: { hasNextPage: false },
  };
}

export async function listOpenPullRequestsForBranch(
  options,
  branch,
  { json = ghJson, maxResults = 1000 } = {},
) {
  if (!branch) {
    throw new Error(
      "release requires a claimed branch so it can prove that no open PR exists",
    );
  }
  const prs = await json([
    "pr",
    "list",
    "-R",
    options.repo,
    "--state",
    "open",
    "--head",
    branch,
    "--limit",
    String(maxResults),
    "--json",
    "number,url,headRefName,headRepository",
  ]);
  if ((prs ?? []).length >= maxResults) {
    throw new Error(
      `Open PR lookup for branch ${branch} reached ${maxResults} results; release cannot prove that no replacement PR exists`,
    );
  }
  const canonicalRepo = splitRepo(options.repo).nameWithOwner.toLowerCase();
  return (prs ?? []).filter(
    (pr) =>
      pr.headRefName === branch &&
      pr.headRepository?.nameWithOwner?.toLowerCase() === canonicalRepo,
  );
}

export async function getPullRequest(options, number) {
  const pr = await ghJson([
    "pr",
    "view",
    String(number),
    "-R",
    options.repo,
    "--json",
    "number,url,state,mergedAt,headRefName,headRepository",
  ]);
  if (!pr?.number) {
    throw new Error(`PR #${number} was not found in ${options.repo}`);
  }
  return pr;
}

export async function listIssueComments(
  options,
  issueNumber,
  {
    graphql = ghGraphql,
    maxPages = MAX_ISSUE_COMMENT_PAGES,
    maxNodes = MAX_ISSUE_COMMENT_NODES,
  } = {},
) {
  const repo = splitRepo(options.repo);
  const comments = [];
  let cursor = null;
  const seenCursors = new Set();
  let pages = 0;
  while (true) {
    if (pages >= maxPages) {
      throw new Error(
        `Issue #${issueNumber} comment pagination exceeded ${maxPages} pages`,
      );
    }
    const response = await graphql(
      `
        query (
          $owner: String!
          $repo: String!
          $number: Int!
          $cursor: String
        ) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              comments(first: 100, after: $cursor) {
                nodes {
                  id
                  body
                  createdAt
                  authorAssociation
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      {
        owner: repo.owner,
        repo: repo.name,
        number: issueNumber,
        cursor,
      },
    );
    const connection = response?.data?.repository?.issue?.comments;
    if (!connection) {
      throw new Error(`Issue #${issueNumber} was not found in ${options.repo}`);
    }
    if (
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    ) {
      throw new Error(
        `Issue #${issueNumber} comment pagination returned an incomplete page`,
      );
    }
    pages += 1;
    const nodes = connection.nodes.filter(Boolean);
    if (comments.length + nodes.length > maxNodes) {
      throw new Error(
        `Issue #${issueNumber} comment pagination exceeded ${maxNodes} nodes`,
      );
    }
    comments.push(...nodes);
    if (connection.pageInfo.hasNextPage === false) break;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(
        `Issue #${issueNumber} comment pagination did not advance cursor`,
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return comments;
}

export async function getPrIssues(options, { graphql = ghGraphql } = {}) {
  if (!options.pr) return [];
  const repo = splitRepo(options.repo);
  const response = await graphql(
    `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id
            state
            closingIssuesReferences(first: 100) {
              nodes {
                number
                repository {
                  nameWithOwner
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { owner: repo.owner, repo: repo.name, number: options.pr },
  );
  const pr = validateOpenPr(response?.data?.repository?.pullRequest, options);
  const connection = pr.closingIssuesReferences;
  if (
    !Array.isArray(connection?.nodes) ||
    typeof connection.pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error(
      `PR #${options.pr} closing issue lookup returned an incomplete page`,
    );
  }
  if (connection.pageInfo.hasNextPage) {
    throw new Error(
      `PR #${options.pr} has more than 100 closing issue references; pass --issue/--issues explicitly so review does not use an incomplete issue set`,
    );
  }
  const issues = connection.nodes;
  return issues
    .filter((issue) => issue?.repository?.nameWithOwner === repo.nameWithOwner)
    .map((issue) => issue.number)
    .filter(Number.isInteger);
}

export async function ensurePrExists(options) {
  if (!options.pr) return;
  const repo = splitRepo(options.repo);
  const response = await ghGraphql(
    `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          id
          state
        }
      }
    }`,
    { owner: repo.owner, repo: repo.name, number: options.pr },
  );
  validateOpenPr(response?.data?.repository?.pullRequest, options);
}
