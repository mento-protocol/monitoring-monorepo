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

/**
 * `pkg:*` label for each watchlist scope (`SOURCE_SCOPES` in
 * file-size-watchlist.mjs). Every scope but `scripts` names its package
 * directly; `scripts/` is repository tooling. An `agent-ready` issue needs at
 * least one `pkg:*` (docs/notes/agent-issue-workflow.md), and the drift issue
 * spans whatever its actionable rows span, so the map is applied per row rather
 * than collapsed to one package. The issue body embeds the whole scan report,
 * so it names rows outside these package areas; `formatIssueBody` says which
 * set the labels describe. `scopePackageLabel` throws on an unmapped
 * scope: filing a groomed-incomplete issue silently is the failure this map
 * exists to prevent, and a test pins the map against the scope list.
 */
const SCOPE_PACKAGE_LABELS = {
  aegis: "pkg:aegis",
  dashboard: "pkg:dashboard",
  indexer: "pkg:indexer",
  "integration-probes": "pkg:integration-probes",
  "metrics-bridge": "pkg:metrics-bridge",
  scripts: "pkg:tooling",
  "shared-config": "pkg:shared-config",
};

const ACTIONABLE_BASE_LABELS = [
  "file-size-watchlist",
  "agent-ready",
  "kind:refactor",
  "priority:p2",
];

/**
 * The risk label this job may write, and the order it ranks them in.
 *
 * The floor is `risk:medium` and this job never writes `risk:low`. The sweep
 * predicate is `agent-ready` plus exactly one `risk:*` equal to `risk:low` plus
 * exactly one `pkg:*` (`hasSweepRouting`, scripts/pr/issue-board-state.mjs), so
 * a `risk:low` write here would let a monthly unattended job hand its own issue
 * to the unattended sweep. docs/notes/backlog-sweep.md forbids exactly that for
 * the automated grooming pass: `risk:low` is proposed and a human applies it.
 * That rule binds every unattended writer of the predicate, not only the pass.
 *
 * Deciding the floor per row was the alternative, and it needs a list of the
 * control surfaces a row can reach. Such a list under-scans: it missed the
 * low-risk rule's credential clause and its production-data clause, so
 * `scripts/sentry/triage/sentry-triage-archive.mjs`, a live actionable row that
 * writes production Sentry state, classified as low risk. A constant floor
 * cannot rot that way, and a human who reads the issue can still apply
 * `risk:low`.
 */
const RISK_FLOOR = "risk:medium";
const RISK_RANK = new Map([
  ["risk:low", 0],
  ["risk:medium", 1],
  ["risk:high", 2],
]);

const MANAGED_LABELS = new Set([
  ...ACTIONABLE_BASE_LABELS,
  ...ACTIVE_QUEUE_LABELS,
  ...Object.values(SCOPE_PACKAGE_LABELS),
]);

function isRiskLabel(label) {
  return label.startsWith("risk:");
}

export function scopePackageLabel(scope) {
  const label = SCOPE_PACKAGE_LABELS[scope];
  if (label === undefined) {
    throw new Error(
      `file-size watchlist scope '${scope}' has no pkg:* label; add it to SCOPE_PACKAGE_LABELS`,
    );
  }
  return label;
}

export function packageLabelsForRows(rows) {
  return [...new Set(rows.map((row) => scopePackageLabel(row.package)))].sort();
}

/**
 * The one `risk:*` the issue carries after the write.
 *
 * Risk is managed by prefix, not by an enumeration of the labels this job may
 * own. Preserving a `risk:*` the job does not recognise and appending its own
 * leaves two risk labels, which `agentReadyRoutingGaps` reports as conflicting
 * — the incomplete-grooming finding this whole change exists to remove.
 *
 * The result is the stricter of the floor and whatever the issue already
 * carries, so an operator who escalates a repeated drift issue to `risk:high`
 * keeps that escalation across the next monthly upsert. The job may narrow
 * risk, never widen it. A `risk:*` outside the three ranked labels is dropped
 * and replaced by the floor; it routes nothing and cannot be ordered.
 */
export function riskLabelForIssue(existingLabels = []) {
  const ranks = existingLabels
    .filter((label) => RISK_RANK.has(label))
    .map((label) => RISK_RANK.get(label));
  const rank = Math.max(RISK_RANK.get(RISK_FLOOR), ...ranks);
  return [...RISK_RANK].find(([, value]) => value === rank)[0];
}

export function actionableLabels(rows, existingLabels = []) {
  return [
    ...ACTIONABLE_BASE_LABELS,
    ...packageLabelsForRows(rows),
    riskLabelForIssue(existingLabels),
  ];
}

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

/**
 * Labels the write carries through untouched.
 *
 * Every `risk:*` drops, because the write appends exactly one and
 * `riskLabelForIssue` has already folded the existing ones into it. A `pkg:*`
 * outside `SCOPE_PACKAGE_LABELS` stays: an extra package area is legal on an
 * `agent-ready` issue and only narrows sweep eligibility, so a job that did not
 * apply it should not remove it.
 */
function preserveUnmanagedLabels(labels) {
  return labels.filter(
    (label) => !MANAGED_LABELS.has(label) && !isRiskLabel(label),
  );
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
        ...actionableLabels(actionableRows, existingLabels),
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
    "The `pkg:*` labels name the package areas of the actionable files only. Current Report below lists every watchlist row, including rows this issue does not ask anyone to touch.",
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
