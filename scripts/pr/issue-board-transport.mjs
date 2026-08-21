/**
 * `gh` and GraphQL transport for the issue board.
 *
 * Every subprocess the board runs lives here: the bounded `gh` runner, the
 * JSON and GraphQL wrappers over it, the issue readers, and the git branch
 * probe. Nothing above this layer spawns a child process.
 */

import { spawn } from "node:child_process";

import { splitRepo, validateOpenPr } from "./issue-board-state.mjs";

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

export function githubProjectScopeHint(stderr, env = process.env) {
  const requiredScopes = String(stderr).match(
    /requires one of the following scopes?\s*:\s*\[([^\r\n]{0,240}?)\]/i,
  )?.[1];
  if (
    !requiredScopes ||
    !/\b(?:read:project|project)\b/i.test(requiredScopes)
  ) {
    return "";
  }
  const credentialGuidance =
    env.GH_TOKEN || env.GITHUB_TOKEN
      ? "Replace the environment-provided GH_TOKEN or GITHUB_TOKEN with one carrying the read/write `project` scope; `gh auth refresh` does not update environment-provided tokens."
      : "Refresh it with: gh auth refresh -h github.com -s project";
  return [
    "GitHub Project V2 operations require the active gh credential's read/write `project` scope.",
    credentialGuidance,
    "`read:project` alone can query a project but cannot run claim, review, or sync mutations.",
  ].join("\n");
}

export function runGh(args, { dryRun = false, mutates = false } = {}) {
  if (dryRun && mutates) {
    process.stderr.write(`[dry-run] ${formatGh(args)}\n`);
    return Promise.resolve("");
  }

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
        const scopeHint = githubProjectScopeHint(stderr);
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

export async function listIssuesByLabel(
  options,
  label,
  { state = "open" } = {},
) {
  const issues = await ghJson([
    "issue",
    "list",
    "-R",
    options.repo,
    "--search",
    `is:issue is:${state} label:${label}`,
    "--limit",
    "1000",
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
  return issues ?? [];
}

export async function getIssue(options, number) {
  return ghJson([
    "issue",
    "view",
    String(number),
    "-R",
    options.repo,
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
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
    pages += 1;
    const nodes = (connection.nodes ?? []).filter(Boolean);
    if (comments.length + nodes.length > maxNodes) {
      throw new Error(
        `Issue #${issueNumber} comment pagination exceeded ${maxNodes} nodes`,
      );
    }
    comments.push(...nodes);
    if (!connection.pageInfo?.hasNextPage) break;
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

export async function getPrIssues(options) {
  if (!options.pr) return [];
  const repo = splitRepo(options.repo);
  const response = await ghGraphql(
    `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          id
          state
          closingIssuesReferences(first:100){
            nodes {
              number
              repository {
                nameWithOwner
              }
            }
          }
        }
      }
    }`,
    { owner: repo.owner, repo: repo.name, number: options.pr },
  );
  const pr = validateOpenPr(response?.data?.repository?.pullRequest, options);
  const issues = pr.closingIssuesReferences?.nodes ?? [];
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
