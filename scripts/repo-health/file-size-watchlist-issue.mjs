#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ISSUE_MARKER = "<!-- file-size-watchlist:monthly -->";

const ACTIVE_QUEUE_LABELS = new Set([
  "agent-active",
  "in-pr",
  "needs-grooming",
]);
const MANAGED_LABELS = new Set([
  "file-size-watchlist",
  "agent-ready",
  ...ACTIVE_QUEUE_LABELS,
  "kind:refactor",
  "priority:p2",
  "risk:low",
]);
const ACTIONABLE_LABELS = [
  "file-size-watchlist",
  "agent-ready",
  "kind:refactor",
  "priority:p2",
  "risk:low",
];

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === "") return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function labelsForIssue(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function preserveUnmanagedLabels(labels) {
  return labels.filter((label) => !MANAGED_LABELS.has(label));
}

function resolvedLabels(labels) {
  return [...preserveUnmanagedLabels(labels), "file-size-watchlist"];
}

export function actionableFileSizeRows(rows) {
  return rows.filter((row) => {
    if (["hard", "near-hard"].includes(row.status)) return true;
    return (
      row.status === "soft" && (row.rawDelta === null || row.rawDelta > 100)
    );
  });
}

export function planIssueSync({ issues, rows, publishReport }) {
  const markedIssues = issues.filter(
    (issue) =>
      issue.pull_request === undefined && issue.body?.includes(ISSUE_MARKER),
  );
  if (markedIssues.length > 1) {
    throw new Error(
      `Found ${markedIssues.length} file-size watchlist issues; expected at most one`,
    );
  }

  const issue = markedIssues[0] ?? null;
  const actionableRows = actionableFileSizeRows(rows);
  const existingLabels = issue === null ? [] : labelsForIssue(issue);
  const protectedIssue =
    issue?.state === "open" &&
    existingLabels.some((label) => ACTIVE_QUEUE_LABELS.has(label));

  if (protectedIssue) {
    return { action: "retain", actionableRows, issue };
  }

  if (actionableRows.length > 0) {
    return {
      action: issue === null ? "create" : "upsert-open",
      actionableRows,
      issue,
      labels: [
        ...preserveUnmanagedLabels(existingLabels),
        ...ACTIONABLE_LABELS,
      ],
    };
  }

  if (publishReport) {
    return {
      action: issue === null ? "create-closed-report" : "upsert-closed-report",
      actionableRows,
      issue,
      labels: resolvedLabels(existingLabels),
    };
  }

  if (issue?.state === "open") {
    return {
      action: "close-resolved",
      actionableRows,
      issue,
      labels: resolvedLabels(existingLabels),
    };
  }

  return { action: "noop", actionableRows, issue };
}

function parseArgs(argv) {
  const args = {
    root: process.env.FILE_SIZE_WATCHLIST_ROOT ?? process.cwd(),
    repo: process.env.FILE_SIZE_WATCHLIST_REPO ?? process.env.GITHUB_REPOSITORY,
    publishReport: parseBoolean(
      process.env.FILE_SIZE_WATCHLIST_PUBLISH_REPORT,
      "FILE_SIZE_WATCHLIST_PUBLISH_REPORT",
    ),
    dryRun: parseBoolean(
      process.env.FILE_SIZE_WATCHLIST_DRY_RUN,
      "FILE_SIZE_WATCHLIST_DRY_RUN",
    ),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--repo") {
      args.repo = argv[++index];
    } else if (arg === "--publish-report") {
      args.publishReport = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    throw new Error("--repo or FILE_SIZE_WATCHLIST_REPO must be owner/name");
  }
  return { ...args, root: resolve(args.root) };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    ...options,
  }).trim();
}

function generateReport(root) {
  const script = resolve(root, "scripts/repo-health/file-size-watchlist.mjs");
  const json = JSON.parse(
    run(process.execPath, [script, "--root", root, "--format", "json"]),
  );
  const issueBody = run(process.execPath, [
    script,
    "--root",
    root,
    "--format",
    "issue",
  ]);
  const mainSha = run("git", ["rev-parse", "HEAD"], { cwd: root });
  return { rows: json.rows, issueBody, mainSha };
}

function listIssues(repo) {
  const pages = JSON.parse(
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues?state=all&labels=file-size-watchlist&per_page=100`,
    ]),
  );
  return pages.flat();
}

function githubRequest(method, endpoint, payload) {
  return JSON.parse(
    run("gh", ["api", "--method", method, endpoint, "--input", "-"], {
      input: JSON.stringify(payload),
    }),
  );
}

function formatIssueBody({ report, actionableRows, repo, runUrl }) {
  const commitUrl = `https://github.com/${repo}/commit/${report.mainSha}`;
  const evidence = [
    ISSUE_MARKER,
    `**Current main:** [\`${report.mainSha}\`](${commitUrl})`,
    runUrl ? `**Workflow run:** [${runUrl}](${runUrl})` : null,
    `**Actionable files:** ${actionableRows.length}`,
    "",
    report.issueBody,
    "",
    "## Actionability rule",
    "",
    "This issue opens for an effective `hard cap` or `near hard cap` row, or for a file already over the effective soft cap that is new to the watchlist or grew by more than 100 raw lines. Raw growth is reported separately from the rough count used for cap status.",
    "",
    "## Done means",
    "",
    "Split or explicitly exempt each actionable row, preserve behavior with package tests, and rerun `node scripts/repo-health/file-size-watchlist.mjs --format issue` until no actionable rows remain.",
  ].filter((line) => line !== null);
  return `${evidence.join("\n")}\n`;
}

function issueTitle(date, actionable) {
  const month = date.slice(0, 7);
  return actionable
    ? `File-size watchlist drift (${month})`
    : `File-size watchlist report (${month})`;
}

function syncIssue({ repo, report, plan, dryRun, runUrl }) {
  const date = new Date().toISOString().slice(0, 10);
  const actionable = plan.actionableRows.length > 0;
  const title = issueTitle(date, actionable);
  const body = formatIssueBody({
    report,
    actionableRows: plan.actionableRows,
    repo,
    runUrl,
  });

  if (dryRun || ["noop", "retain"].includes(plan.action)) {
    return {
      issue: plan.issue,
      mutation: dryRun ? "dry-run" : plan.action,
      title,
      body,
    };
  }

  if (["create", "create-closed-report"].includes(plan.action)) {
    const issue = githubRequest("POST", `repos/${repo}/issues`, {
      title,
      body,
      labels: plan.labels,
    });
    if (plan.action === "create-closed-report") {
      return {
        issue: githubRequest("PATCH", `repos/${repo}/issues/${issue.number}`, {
          state: "closed",
          state_reason: "completed",
          labels: plan.labels,
        }),
        mutation: plan.action,
        title,
        body,
      };
    }
    return { issue, mutation: plan.action, title, body };
  }

  const state = plan.action === "upsert-open" ? "open" : "closed";
  const payload = { title, body, state, labels: plan.labels };
  if (state === "closed") payload.state_reason = "completed";
  return {
    issue: githubRequest(
      "PATCH",
      `repos/${repo}/issues/${plan.issue.number}`,
      payload,
    ),
    mutation: plan.action,
    title,
    body,
  };
}

function appendSummary(result) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const issueLine = result.issue?.url
    ? `Issue: [#${result.issue.number}](${result.issue.url})`
    : "Issue: none";
  appendFileSync(
    path,
    [
      "## File-size watchlist",
      "",
      `Current main: \`${result.currentMainSha}\``,
      `Actionable files: ${result.actionableFiles}`,
      `Decision: \`${result.decision}\``,
      `Mutation: \`${result.mutation}\``,
      issueLine,
      "",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = generateReport(args.root);
  const issues = listIssues(args.repo);
  const plan = planIssueSync({
    issues,
    rows: report.rows,
    publishReport: args.publishReport,
  });
  const synced = syncIssue({
    repo: args.repo,
    report,
    plan,
    dryRun: args.dryRun,
    runUrl: process.env.FILE_SIZE_WATCHLIST_RUN_URL,
  });
  const result = {
    currentMainSha: report.mainSha,
    actionableFiles: plan.actionableRows.length,
    decision: plan.action,
    mutation: synced.mutation,
    issue: synced.issue
      ? { number: synced.issue.number, url: synced.issue.html_url }
      : null,
  };
  appendSummary(result);
  console.log(args.json ? JSON.stringify(result) : result.mutation);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const _private = {
  formatIssueBody,
  issueTitle,
  parseArgs,
};
