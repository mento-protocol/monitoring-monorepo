/**
 * GitHub route and I/O layer for Sentry verdict projection. The entry module
 * owns mode orchestration. This module owns the bounded GitHub issue routes:
 * external owning repos use the projection PAT; local config work uses the
 * ambient Actions token.
 */

import { spawn } from "node:child_process";

import {
  AGENT_READY_LABEL_DEFINITION,
  ensureLabelsExist,
  ISSUE_STATE_LABEL_DEFINITIONS,
} from "../../lib/gh-issue-lifecycle.mjs";
import { PROJECTED_LABEL } from "./sentry-triage-project-core.mjs";
import {
  ALIAS_NOTE_PREFIX,
  bodyBacklinksShortId,
  commentBacklinksShortId,
} from "./sentry-triage-projection.mjs";

export const AGENT_READY_LABEL = AGENT_READY_LABEL_DEFINITION.name;

// `projectable` remains the external-write capability. This closed routing
// enum adds one exact local destination without widening that capability.
export const PROJECTION_DESTINATIONS = {
  EXTERNAL: "external",
  LOCAL_CONFIG: "local-config",
  NONE: "none",
};

// `gh issue list` reports workflow-created issues as the Actions App. Comments
// use a separate fence because their API surface reports `github-actions` and
// `github-actions[bot]` instead.
export const WORKFLOW_ISSUE_AUTHOR = "app/github-actions";

export function isWorkflowCreatedIssue(login) {
  return login === WORKFLOW_ISSUE_AUTHOR;
}

export function projectionDestination(verdict, repoCheck) {
  if (repoCheck?.projectable === true) {
    return PROJECTION_DESTINATIONS.EXTERNAL;
  }
  if (verdict === "config-fix" && repoCheck?.reason === "local-repo") {
    return PROJECTION_DESTINATIONS.LOCAL_CONFIG;
  }
  return PROJECTION_DESTINATIONS.NONE;
}

export function defaultRunGh(args, { token } = {}) {
  return new Promise((resolve, reject) => {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (status) => {
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

export async function readQueueIssue(localRun, repo, number) {
  const stdout = await localRun([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,url,state,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    url: data.url ?? "",
    state: String(data.state ?? "").toUpperCase(),
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

const FOOTER_SEARCH_PHRASE = "Sentry triage pipeline";

export async function fetchProjectorLogin(owningRun) {
  const stdout = await owningRun(["api", "user", "--jq", ".login"]);
  const login = String(stdout ?? "").trim();
  if (!login) {
    throw new Error(
      "Could not resolve the projection token's own user login (gh api user returned empty); refusing to match existing projections without an author identity.",
    );
  }
  return login;
}

export async function findExistingProjection(
  owningRun,
  owningRepo,
  shortId,
  { isIssueAuthor, isCommentAuthor },
) {
  const stdout = await owningRun([
    "issue",
    "list",
    "-R",
    owningRepo,
    "--state",
    "all",
    "--search",
    `"${shortId}" "${FOOTER_SEARCH_PHRASE}" in:body,comments`,
    "--json",
    "number,url,body,state,author",
    "--limit",
    "200",
  ]);
  const items = stdout && stdout.trim() ? JSON.parse(stdout) : [];
  const issueMatches = (Array.isArray(items) ? items : []).filter((item) =>
    isIssueAuthor(item.author?.login ?? ""),
  );
  const toResult = (item) => ({
    number: item.number,
    url: item.url,
    state: String(item.state ?? "").toUpperCase(),
  });
  const direct = issueMatches.find((item) =>
    bodyBacklinksShortId(item.body, shortId),
  );
  if (direct) return toResult(direct);

  const aliasStdout = await owningRun([
    "issue",
    "list",
    "-R",
    owningRepo,
    "--state",
    "all",
    "--search",
    `"${ALIAS_NOTE_PREFIX} ${shortId}" in:comments`,
    "--json",
    "number,url,state,author",
    "--limit",
    "200",
  ]);
  const aliasItems =
    aliasStdout && aliasStdout.trim() ? JSON.parse(aliasStdout) : [];
  const aliasCandidates = (Array.isArray(aliasItems) ? aliasItems : []).filter(
    (item) => isIssueAuthor(item.author?.login ?? ""),
  );
  const MAX_CANDIDATE_READS = 10;
  if (aliasCandidates.length > MAX_CANDIDATE_READS) {
    throw new Error(
      `Alias lookup for ${shortId} in ${owningRepo} returned ${aliasCandidates.length} projector-authored candidates (max ${MAX_CANDIDATE_READS}); refusing to risk missing the genuine alias — failing loud for retry.`,
    );
  }
  for (const item of aliasCandidates) {
    const hasAlias = await hasAliasComment(
      owningRun,
      owningRepo,
      item.number,
      shortId,
      isCommentAuthor,
    );
    if (hasAlias) return toResult(item);
  }
  return null;
}

const REPROJECTION_REOPEN_COMMENT =
  "Reopened by the Mento Sentry triage pipeline: the underlying Sentry issue " +
  "regressed and was re-triaged as actionable.";

// Local create consumes only the agent-ready lifecycle label. It creates a
// missing label from the shared canonical definition and never force-edits
// existing shared metadata. The ensure is best-effort. The issue mutation
// remains authoritative and fails loudly if the label is still absent.
export async function ensureAgentReadyLabel(owningRun, owningRepo) {
  try {
    await ensureLabelsExist(
      { repo: owningRepo },
      {
        runner: owningRun,
        definitions: [AGENT_READY_LABEL_DEFINITION],
      },
    );
  } catch (error) {
    process.stderr.write(
      `warning: could not ensure label ${AGENT_READY_LABEL}: ${error.message}\n`,
    );
  }
}

async function ensureIssueStateLabels(owningRun, owningRepo) {
  try {
    await ensureLabelsExist(
      { repo: owningRepo },
      {
        runner: owningRun,
        definitions: ISSUE_STATE_LABEL_DEFINITIONS,
      },
    );
  } catch (error) {
    process.stderr.write(
      `warning: could not ensure issue-state labels: ${error.message}\n`,
    );
  }
}

export async function reopenProjectedIssue(
  owningRun,
  owningRepo,
  existing,
  { restoreAgentReady = false } = {},
) {
  // Repair the closed local issue before reopening it. If the edit fails, it
  // remains CLOSED so a retry runs this repair again instead of treating the
  // stale lifecycle as an already-open issue to preserve.
  if (restoreAgentReady) {
    await ensureIssueStateLabels(owningRun, owningRepo);
    await owningRun([
      "issue",
      "edit",
      String(existing.number),
      "-R",
      owningRepo,
      "--add-label",
      AGENT_READY_LABEL,
      "--remove-label",
      "agent-active,in-pr,needs-grooming",
    ]);
  }
  await owningRun([
    "issue",
    "reopen",
    String(existing.number),
    "-R",
    owningRepo,
  ]);
  await owningRun([
    "issue",
    "comment",
    String(existing.number),
    "-R",
    owningRepo,
    "--body",
    REPROJECTION_REOPEN_COMMENT,
  ]);
}

export async function createProjectedIssue(
  owningRun,
  owningRepo,
  title,
  body,
  { labels = [] } = {},
) {
  const args = [
    "issue",
    "create",
    "-R",
    owningRepo,
    "--title",
    title,
    "--body",
    body,
  ];
  for (const label of labels) args.push("--label", label);
  const stdout = await owningRun(args);
  const url = String(stdout).trim().split(/\s+/).filter(Boolean).pop();
  if (!url || !/^https:\/\/github\.com\//.test(url)) {
    throw new Error(
      `gh issue create did not return a github.com URL (got: ${JSON.stringify(url)})`,
    );
  }
  return url;
}

async function hasAliasComment(
  owningRun,
  owningRepo,
  number,
  shortId,
  isCommentAuthor,
) {
  const stdout = await owningRun([
    "issue",
    "view",
    String(number),
    "-R",
    owningRepo,
    "--json",
    "comments",
  ]);
  const comments = JSON.parse(stdout).comments ?? [];
  return comments.some(
    (comment) =>
      isCommentAuthor(comment?.author?.login ?? "") &&
      commentBacklinksShortId(comment?.body, shortId),
  );
}

export async function markStubProjected(
  localRun,
  localRepo,
  issue,
  projectedUrl,
  projectedCommentPrefix,
) {
  await localRun([
    "issue",
    "edit",
    String(issue.number),
    "-R",
    localRepo,
    "--add-label",
    PROJECTED_LABEL,
  ]);
  if (!issue.labels.includes(PROJECTED_LABEL)) {
    await localRun([
      "issue",
      "comment",
      String(issue.number),
      "-R",
      localRepo,
      "--body",
      `${projectedCommentPrefix}${projectedUrl}`,
    ]);
  }
}
