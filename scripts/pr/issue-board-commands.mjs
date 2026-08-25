/**
 * Issue-board commands: claim, review, release, sync, and backfill.
 *
 * Each command drives one label transition, projects it onto the workboard,
 * and posts the matching issue comment. Label edits happen first and roll back
 * when the project write fails, so labels stay authoritative.
 */

import {
  chooseUntriedCandidate,
  isClaimable,
  isRecoverableClaimRaceError,
  isReleasable,
  isReviewable,
  ISSUE_STATE_LABELS,
  labelNames,
  labelsForState,
  shouldRollbackFailedTransition,
  stateFromLabels,
} from "./issue-board-state.mjs";
import {
  ensureProjectItem,
  findIssueProjectItem,
  getProject,
  hasDifferentClaimId,
  readBackfillProjectFields,
  requireBackfillFields,
  requireClaimIdField,
  updateProjectFields,
  verifyClaimOwnership,
  writeBackfillProjectFields,
} from "./issue-board-projects.mjs";
import {
  ensurePrExists,
  getGitBranch,
  getIssue,
  getPrIssues,
  listIssueComments,
  listIssuesByLabel,
  listReadyIssues,
  runGh,
  sleep,
} from "./issue-board-transport.mjs";
import { backfillIssue } from "./issue-board-backfill.mjs";

const CLAIM_SETTLE_MS = 1500;
const SYNC_RECONCILE_ATTEMPTS = 3;
const SYNC_VERIFY_ATTEMPTS = 3;
const SYNC_VERIFY_SETTLE_MS = 250;

async function editIssueLabels(options, issue, state) {
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

export function buildClaimComment(metadata, issue) {
  const lines = [
    `Agent claim: ${metadata.agent} claimed #${issue.number} for implementation.`,
    "",
    `Claim ID: ${metadata.claimId}`,
  ];
  if (metadata.branch) lines.push(`Branch: ${metadata.branch}`);
  lines.push(`Claimed at: ${metadata.claimedAt}`);
  return lines.join("\n");
}

function buildReviewComment(metadata, issue) {
  const lines = [
    `Moved to review: #${issue.number} is now represented by PR #${metadata.pr}.`,
  ];
  if (metadata.branch) lines.push(`Branch: ${metadata.branch}`);
  return lines.join("\n");
}

function buildReleaseComment(metadata, issue, state) {
  const label = state === "grooming" ? "needs-grooming" : "agent-ready";
  return `Released agent claim: #${issue.number} is back in ${label}.`;
}

async function commentOnIssue(options, issue, body) {
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

function claimIdFor(options, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${options.agent}-${stamp}-${suffix}`;
}

async function transitionIssue(options, project, issue, state, metadata) {
  const previousState = stateFromLabels(issue);
  await editIssueLabels(options, issue, state);
  try {
    const itemId = await ensureProjectItem(options, project, issue);
    await updateProjectFields(options, project, itemId, state, metadata);
    return itemId;
  } catch (err) {
    const observedDifferentClaim =
      !options.dryRun && state === "active"
        ? await hasDifferentClaimId(options, project, issue, metadata.claimId)
        : false;
    if (
      !options.dryRun &&
      shouldRollbackFailedTransition(
        state,
        previousState,
        observedDifferentClaim,
      )
    ) {
      const current = await getIssue(options, issue.number);
      await editIssueLabels(options, current, previousState);
    }
    throw err;
  }
}

function claimMetadata(options, branch) {
  return {
    agent: options.agent,
    branch: branch || undefined,
    claimId: claimIdFor(options),
    claimedAt: new Date().toISOString(),
    pr: options.pr ?? null,
  };
}

async function claimIssue(options, project, issue, metadata) {
  requireClaimIdField(project);
  if (!isClaimable(issue)) {
    throw new Error(
      `Issue #${issue.number} is not claimable; expected open agent-ready without agent-active/in-pr`,
    );
  }
  const itemId = await transitionIssue(
    options,
    project,
    issue,
    "active",
    metadata,
  );
  if (options.dryRun) {
    await commentOnIssue(options, issue, buildClaimComment(metadata, issue));
    return { number: issue.number, title: issue.title, state: "active" };
  }
  await sleep(CLAIM_SETTLE_MS);
  await verifyClaimOwnership(options, project, itemId, issue, metadata);
  const verified = await getIssue(options, issue.number);
  if (!labelNames(verified).has("agent-active")) {
    throw new Error(`Issue #${issue.number} did not retain agent-active`);
  }
  if (
    labelNames(verified).has("agent-ready") ||
    labelNames(verified).has("in-pr")
  ) {
    throw new Error(`Issue #${issue.number} has conflicting state labels`);
  }
  await commentOnIssue(
    options,
    verified,
    buildClaimComment(metadata, verified),
  );
  return { number: verified.number, title: verified.title, state: "active" };
}

export async function claim(options) {
  const branch = options.branch || (await getGitBranch());
  const project = await getProject(options);
  const results = [];
  if (options.issues.length > 0) {
    for (const number of options.issues) {
      const issue = await getIssue(options, number);
      results.push(
        await claimIssue(
          options,
          project,
          issue,
          claimMetadata(options, branch),
        ),
      );
    }
    return results;
  }

  const triedNumbers = new Set();
  const candidateLimit = Math.min(Math.max(options.count * 5, 10), 100);
  while (results.length < options.count) {
    const candidates = await listReadyIssues({
      ...options,
      count: candidateLimit,
    });
    const candidate = chooseUntriedCandidate(candidates, triedNumbers);
    if (!candidate) break;
    triedNumbers.add(candidate.number);
    const issue = await getIssue(options, candidate.number);
    if (!isClaimable(issue)) continue;
    try {
      results.push(
        await claimIssue(
          options,
          project,
          issue,
          claimMetadata(options, branch),
        ),
      );
    } catch (err) {
      if (!isRecoverableClaimRaceError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Skipped #${issue.number}: ${message}\n`);
    }
  }

  if (results.length === 0) {
    throw new Error("No claimable agent-ready issues found");
  }
  return results;
}

export async function review(options) {
  if (!options.pr) {
    throw new Error(
      "review requires --pr so reviewed issues are linked to a pull request",
    );
  }
  if (options.issues.length > 0) {
    await ensurePrExists(options);
  }
  const project = await getProject(options);
  const inferredIssues =
    options.issues.length > 0 ? [] : await getPrIssues(options);
  const issueNumbers =
    options.issues.length > 0 ? options.issues : inferredIssues;
  if (issueNumbers.length === 0) {
    throw new Error(
      "review requires --issue/--issues or a PR with closing issues",
    );
  }
  const branch = options.branch || (await getGitBranch());
  const metadata = {
    agent: options.agent,
    branch: branch || undefined,
    pr: options.pr,
  };
  const results = [];
  for (const number of issueNumbers) {
    const issue = await getIssue(options, number);
    if (!isReviewable(issue)) {
      throw new Error(
        `Issue #${issue.number} is not reviewable; expected open agent-active without agent-ready/in-pr`,
      );
    }
    await transitionIssue(options, project, issue, "review", metadata);
    await commentOnIssue(options, issue, buildReviewComment(metadata, issue));
    results.push({ number: issue.number, title: issue.title, state: "review" });
  }
  return results;
}

export async function release(options) {
  if (options.issues.length === 0) {
    throw new Error("release requires --issue/--issues");
  }
  const project = await getProject(options);
  const metadata = {
    agent: null,
    branch: null,
    claimId: null,
    claimedAt: null,
    pr: null,
  };
  const results = [];
  for (const number of options.issues) {
    const issue = await getIssue(options, number);
    if (!isReleasable(issue)) {
      throw new Error(
        `Issue #${issue.number} is not releasable; expected open agent-active or in-pr without agent-ready/needs-grooming`,
      );
    }
    await transitionIssue(
      options,
      project,
      issue,
      options.releaseState,
      metadata,
    );
    await commentOnIssue(
      options,
      issue,
      buildReleaseComment(metadata, issue, options.releaseState),
    );
    results.push({
      number: issue.number,
      title: issue.title,
      state: options.releaseState,
    });
  }
  return results;
}

async function verifySyncCloseout(options, issue, operations) {
  let staleLabels = [];
  for (let attempt = 1; attempt <= SYNC_VERIFY_ATTEMPTS; attempt += 1) {
    const verified = await operations.getIssue(options, issue.number);
    const verifiedState = String(verified.state ?? "").toUpperCase();
    if (verifiedState !== "CLOSED") {
      throw new Error(
        `Issue #${issue.number} changed state during sync: expected CLOSED, got ${verifiedState || "UNKNOWN"}`,
      );
    }
    const verifiedLabels = labelNames(verified);
    staleLabels = ISSUE_STATE_LABELS.filter((label) =>
      verifiedLabels.has(label),
    );
    if (staleLabels.length === 0) return;
    if (attempt < SYNC_VERIFY_ATTEMPTS) {
      await operations.sleep(SYNC_VERIFY_SETTLE_MS);
    }
  }
  throw new Error(
    `Issue #${issue.number} retained queue label(s) after sync: ${staleLabels.join(", ")}`,
  );
}

function syncStateFromIssue(issue) {
  const state = stateFromLabels(issue);
  if (state) return state;
  return String(issue.state ?? "").toUpperCase() === "CLOSED" ? "done" : null;
}

async function syncIssue(options, project, listedIssue, operations) {
  let issue = await operations.getIssue(options, listedIssue.number);
  let drift = null;

  for (let attempt = 1; attempt <= SYNC_RECONCILE_ATTEMPTS; attempt += 1) {
    const state = syncStateFromIssue(issue);
    if (!state) {
      if (!drift) return null;
      if (attempt < SYNC_RECONCILE_ATTEMPTS) {
        await operations.sleep(SYNC_VERIFY_SETTLE_MS);
        issue = await operations.getIssue(options, issue.number);
        continue;
      }
      throw new Error(
        `Issue #${issue.number} lost its queue state during sync after ${attempt} attempt(s); last projection drift was ${drift}`,
      );
    }

    if (state === "done") {
      const itemId = await operations.findIssueProjectItem(
        options,
        issue,
        project,
      );
      if (itemId) {
        await operations.updateProjectFields(
          options,
          project,
          itemId,
          state,
          {},
        );
      }
      await operations.editIssueLabels(options, issue, state);
      if (!options.dryRun) {
        await verifySyncCloseout(options, issue, operations);
      }
      return { number: issue.number, title: issue.title, state };
    }

    const itemId = await operations.ensureProjectItem(options, project, issue);
    if (!itemId) return null;
    await operations.updateProjectFields(options, project, itemId, state, {});
    if (options.dryRun) {
      return { number: issue.number, title: issue.title, state };
    }

    const verified = await operations.getIssue(options, issue.number);
    const verifiedState = syncStateFromIssue(verified);
    if (verifiedState === state) {
      return { number: issue.number, title: issue.title, state };
    }

    drift = `${state} -> ${verifiedState ?? "no queue state"}`;
    if (attempt < SYNC_RECONCILE_ATTEMPTS) {
      issue = verified;
      await operations.sleep(SYNC_VERIFY_SETTLE_MS);
    }
  }

  throw new Error(
    `Issue #${issue.number} did not stabilize during sync after ${SYNC_RECONCILE_ATTEMPTS} attempts; last projection drift was ${drift}`,
  );
}

export async function sync(options, dependencies = {}) {
  const operations = {
    editIssueLabels,
    ensureProjectItem,
    findIssueProjectItem,
    getIssue,
    getProject,
    listIssuesByLabel,
    sleep,
    updateProjectFields,
    ...dependencies,
  };
  const project = await operations.getProject(options);
  const byNumber = new Map();
  for (const label of ISSUE_STATE_LABELS) {
    for (const state of ["open", "closed"]) {
      for (const issue of await operations.listIssuesByLabel(options, label, {
        state,
      })) {
        byNumber.set(issue.number, issue);
      }
    }
  }

  const results = [];
  for (const listedIssue of byNumber.values()) {
    const result = await syncIssue(options, project, listedIssue, operations);
    if (result) results.push(result);
  }
  return results;
}

export async function backfill(options, dependencies = {}) {
  return [
    await backfillIssue(options, {
      getIssue: dependencies.getIssue ?? getIssue,
      getProject: dependencies.getProject ?? getProject,
      findIssueProjectItem:
        dependencies.findIssueProjectItem ?? findIssueProjectItem,
      listIssueComments: dependencies.listIssueComments ?? listIssueComments,
      requireBackfillFields:
        dependencies.requireBackfillFields ?? requireBackfillFields,
      readBackfillProjectFields:
        dependencies.readBackfillProjectFields ?? readBackfillProjectFields,
      writeBackfillProjectFields:
        dependencies.writeBackfillProjectFields ?? writeBackfillProjectFields,
    }),
  ];
}

export function renderResults(results) {
  if (results.length === 0) return "No issues changed.";
  return results
    .map((issue) => {
      const writes = issue.writes
        ?.map((write) => `${write.field}=${write.value}`)
        .join(", ");
      return `#${issue.number} ${issue.state}: ${issue.title}${writes ? ` (${writes})` : ""}`;
    })
    .join("\n");
}
