/**
 * Owner-aware release transactions for the issue board.
 *
 * Release uses the durable Project ownership snapshot. It never infers the
 * claimed branch from the local checkout. A closed-unmerged PR uses an
 * explicit release path with stored PR and branch proof.
 */

import {
  exactQueueState,
  IssueOwnershipConflictError,
  isReleasable,
  labelNames,
} from "./issue-board-state.mjs";
import {
  findIssueProjectItem,
  getProject,
  updateProjectMetadata as writeProjectMetadata,
} from "./issue-board-projects.mjs";
import {
  assertExactClaimOwnership,
  readClaimOwnership,
  requireOwnershipFields,
  writeProjectOwnershipMetadata,
} from "./issue-board-ownership.mjs";
import {
  IssueOwnerMutationCapabilityError,
  withIssueMutationLock,
} from "./issue-board-lock.mjs";
import {
  commentOnIssue,
  editIssueLabels,
  getIssue,
  getPullRequest,
  listOpenPullRequestsForBranch,
  pullRequestHeadRepositoryNameWithOwner,
} from "./issue-board-transport.mjs";

const EMPTY_OWNERSHIP = {
  agent: null,
  branch: null,
  claimId: null,
  claimedAt: null,
  pr: null,
};

function dependenciesFor(overrides = {}) {
  return {
    commentOnIssue: overrides.commentOnIssue ?? commentOnIssue,
    editIssueLabels: overrides.editIssueLabels ?? editIssueLabels,
    findIssueProjectItem:
      overrides.findIssueProjectItem ?? findIssueProjectItem,
    getIssue: overrides.getIssue ?? getIssue,
    getProject: overrides.getProject ?? getProject,
    getPullRequest: overrides.getPullRequest ?? getPullRequest,
    listOpenPullRequestsForBranch:
      overrides.listOpenPullRequestsForBranch ?? listOpenPullRequestsForBranch,
    readClaimOwnership: overrides.readClaimOwnership ?? readClaimOwnership,
    updateProjectMetadata:
      overrides.updateProjectMetadata ??
      ((
        options,
        project,
        itemId,
        _state,
        metadata,
        capability,
        issue,
        operation,
      ) =>
        writeProjectMetadata(capability, options, project, itemId, metadata, {
          issueNumber: issue.number,
          operation,
        })),
    withIssueMutationLock:
      overrides.withIssueMutationLock ?? withIssueMutationLock,
  };
}

function buildReleaseComment(issue, state, { closedUnmergedPr, mergedPr }) {
  const label = state === "grooming" ? "needs-grooming" : "agent-ready";
  const source = closedUnmergedPr
    ? " after its PR closed unmerged"
    : mergedPr
      ? " after its merged PR left follow-up work"
      : "";
  return `Released agent claim: #${issue.number} is back in ${label}${source}.`;
}

function ownershipConflict(issue, expectedClaimId, actualClaimId, message) {
  return new IssueOwnershipConflictError(message, {
    issue: issue.number,
    expectedClaimId,
    actualClaimId,
  });
}

function assertOwned(issue, ownership, expectedClaimId) {
  if (ownership.claimId !== expectedClaimId) {
    throw ownershipConflict(
      issue,
      expectedClaimId,
      ownership.claimId,
      `Issue #${issue.number} is owned by project Claim ID ${ownership.claimId ?? "<empty>"} instead of ${expectedClaimId}`,
    );
  }
  if (!ownership.branch) {
    throw new Error(
      `Issue #${issue.number} ownership is missing Branch; release refuses ambient or local branch fallback`,
    );
  }
}

function sameOwnership(left, right) {
  return ["claimId", "agent", "branch", "claimedAt", "pr"].every(
    (field) => left[field] === right[field],
  );
}

function isOwnedReleasePartial(current, snapshot) {
  return ["claimId", "agent", "branch", "claimedAt", "pr"].every(
    (field) => current[field] === snapshot[field] || current[field] == null,
  );
}

function isReviewReleaseState(issue) {
  const labels = labelNames(issue);
  return (
    String(issue.state ?? "").toUpperCase() === "OPEN" &&
    labels.has("in-pr") &&
    !labels.has("agent-active") &&
    !labels.has("agent-ready") &&
    !labels.has("needs-grooming")
  );
}

function isQuarantinedReleaseState(issue) {
  const labels = labelNames(issue);
  return (
    String(issue.state ?? "").toUpperCase() === "OPEN" &&
    labels.has("needs-grooming") &&
    !labels.has("agent-active") &&
    !labels.has("agent-ready") &&
    !labels.has("in-pr")
  );
}

function matchesReleasedState(issue, state) {
  const labels = labelNames(issue);
  const expected = state === "grooming" ? "needs-grooming" : "agent-ready";
  return (
    String(issue.state ?? "").toUpperCase() === "OPEN" &&
    labels.has(expected) &&
    !labels.has("agent-active") &&
    !labels.has("in-pr") &&
    (state === "grooming" || !labels.has("needs-grooming")) &&
    (state === "ready" || !labels.has("agent-ready"))
  );
}

function assertReleaseState(issue, options) {
  if (options.closedUnmergedPr || options.mergedPr) {
    if (!isReviewReleaseState(issue)) {
      const flag = options.mergedPr ? "--merged-pr" : "--closed-unmerged-pr";
      throw new Error(
        `Issue #${issue.number} is not eligible for ${flag}; expected open in-pr without agent-ready/agent-active/needs-grooming`,
      );
    }
    return "review";
  }
  if (options.releaseState === "grooming" && isQuarantinedReleaseState(issue)) {
    return "grooming";
  }
  if (!isReleasable(issue)) {
    throw new Error(
      `Issue #${issue.number} is not releasable; expected open agent-active without agent-ready/in-pr/needs-grooming`,
    );
  }
  return "active";
}

function openPrError(issue, branch, openPr) {
  return new Error(
    `Issue #${issue.number} is not releasable because branch ${branch} has open PR #${openPr.number}`,
  );
}

async function assertNoOpenPr(options, issue, branch, dependencies) {
  const prs = await dependencies.listOpenPullRequestsForBranch(options, branch);
  if (prs.length > 0) throw openPrError(issue, branch, prs[0]);
}

async function assertClosedPrBinding(options, issue, ownership, dependencies) {
  if (!ownership.pr) {
    throw new Error(
      `Issue #${issue.number} has no stored PR for --closed-unmerged-pr`,
    );
  }
  const pr = await dependencies.getPullRequest(options, ownership.pr);
  if (pr.state !== "CLOSED" || pr.mergedAt != null) {
    throw new Error(
      `Issue #${issue.number} stored PR #${ownership.pr} must be CLOSED and unmerged before release`,
    );
  }
  if (
    pr.headRefName !== ownership.branch ||
    pullRequestHeadRepositoryNameWithOwner(pr) !== options.repo.toLowerCase()
  ) {
    throw new Error(
      `Issue #${issue.number} stored PR #${ownership.pr} does not match claimed branch ${ownership.branch} in ${options.repo}`,
    );
  }
  await assertNoOpenPr(options, issue, ownership.branch, dependencies);
}

async function assertMergedPrBinding(options, issue, ownership, dependencies) {
  if (!ownership.pr) {
    throw new Error(`Issue #${issue.number} has no stored PR for --merged-pr`);
  }
  const pr = await dependencies.getPullRequest(options, ownership.pr);
  if (pr.state !== "MERGED" || pr.mergedAt == null) {
    throw new Error(
      `Issue #${issue.number} stored PR #${ownership.pr} must be MERGED with a merge timestamp before continuation`,
    );
  }
  if (
    pr.headRefName !== ownership.branch ||
    pullRequestHeadRepositoryNameWithOwner(pr) !== options.repo.toLowerCase()
  ) {
    throw new Error(
      `Issue #${issue.number} stored PR #${ownership.pr} does not match claimed branch ${ownership.branch} in ${options.repo}`,
    );
  }
  await assertNoOpenPr(options, issue, ownership.branch, dependencies);
}

async function assertReleaseProof(options, issue, ownership, dependencies) {
  if (options.mergedPr) {
    await assertMergedPrBinding(options, issue, ownership, dependencies);
    return;
  }
  if (options.closedUnmergedPr) {
    await assertClosedPrBinding(options, issue, ownership, dependencies);
    return;
  }
  await assertNoOpenPr(options, issue, ownership.branch, dependencies);
}

async function restoreFailedRelease(
  options,
  project,
  itemId,
  issue,
  previousState,
  snapshot,
  dependencies,
  capability,
) {
  const current = await dependencies.getIssue(options, issue.number);
  const currentState = exactQueueState(current);
  if (!currentState) {
    throw new Error(
      `Issue #${issue.number} has no exact open queue state for release recovery`,
    );
  }
  const currentOwnership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  const transactionStates = new Set([previousState, options.releaseState]);
  if (
    !transactionStates.has(currentState) &&
    ["active", "review", "grooming"].includes(currentState)
  ) {
    const verifiedIssue = await dependencies.getIssue(options, issue.number);
    const verifiedOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    if (
      exactQueueState(verifiedIssue) !== currentState ||
      !sameOwnership(verifiedOwnership, currentOwnership)
    ) {
      throw new Error(
        `Issue #${issue.number} newer ${currentState} state changed during release recovery`,
      );
    }
    if (
      !sameOwnership(currentOwnership, snapshot) ||
      !sameOwnership(verifiedOwnership, snapshot)
    ) {
      throw new Error(
        `Issue #${issue.number} newer ${currentState} state has partial or changed ownership during release recovery`,
      );
    }
    return { preserved: true, state: currentState };
  }
  if (!transactionStates.has(currentState)) {
    throw new Error(
      `Issue #${issue.number} release recovery found ambiguous ${currentState} state`,
    );
  }
  if (
    currentState === "grooming" &&
    options.releaseState === "grooming" &&
    sameOwnership(currentOwnership, EMPTY_OWNERSHIP)
  ) {
    const verifiedIssue = await dependencies.getIssue(options, issue.number);
    const verifiedOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    if (
      exactQueueState(verifiedIssue) !== "grooming" ||
      !sameOwnership(verifiedOwnership, EMPTY_OWNERSHIP)
    ) {
      throw new Error(
        `Issue #${issue.number} completed grooming release changed during recovery`,
      );
    }
    return { preserved: true, state: "grooming" };
  }
  if (
    currentState === previousState &&
    sameOwnership(currentOwnership, snapshot)
  ) {
    const verifiedIssue = await dependencies.getIssue(options, issue.number);
    const verifiedOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    if (
      exactQueueState(verifiedIssue) !== previousState ||
      !sameOwnership(verifiedOwnership, snapshot)
    ) {
      throw new Error(
        `Issue #${issue.number} release pre-state changed during recovery`,
      );
    }
    return { preserved: false, state: previousState };
  }
  if (currentState !== "ready") {
    throw new Error(
      `Issue #${issue.number} release recovery is ambiguous at ${currentState} with partial or changed ownership`,
    );
  }
  if (!isOwnedReleasePartial(currentOwnership, snapshot)) {
    throw ownershipConflict(
      issue,
      snapshot.claimId,
      currentOwnership.claimId,
      `Issue #${issue.number} ownership changed before release compensation`,
    );
  }
  const compensationIssue = await dependencies.getIssue(options, issue.number);
  const compensationOwnership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  if (
    exactQueueState(compensationIssue) !== "ready" ||
    !sameOwnership(compensationOwnership, currentOwnership)
  ) {
    throw new Error(
      `Issue #${issue.number} ready-state release compensation changed before its write`,
    );
  }
  await dependencies.editIssueLabels(options, compensationIssue, previousState);
  const ownershipBeforeRestore = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  assertExactClaimOwnership(
    compensationIssue,
    ownershipBeforeRestore,
    compensationOwnership,
    "before release recovery metadata write",
  );
  await writeProjectOwnershipMetadata(
    options,
    project,
    itemId,
    compensationIssue,
    previousState,
    ownershipBeforeRestore,
    snapshot,
    {
      readOwnership: dependencies.readClaimOwnership,
      updateMetadata: dependencies.updateProjectMetadata,
    },
    capability,
    "release",
  );
  const verifiedIssue = await dependencies.getIssue(options, issue.number);
  const verifiedOwnership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  const labelsRestored =
    previousState === "review"
      ? isReviewReleaseState(verifiedIssue)
      : previousState === "grooming"
        ? isQuarantinedReleaseState(verifiedIssue)
        : isReleasable(verifiedIssue);
  if (!labelsRestored || !sameOwnership(verifiedOwnership, snapshot)) {
    throw new Error(
      `Issue #${issue.number} release compensation did not restore its exact non-ready ownership snapshot`,
    );
  }
  return { preserved: false, state: previousState };
}

async function releaseLocked(
  options,
  project,
  preview,
  dependencies,
  lease,
  capability,
) {
  let mutationAttempted = false;
  let issue = preview.issue;
  let previousState;
  try {
    issue = await dependencies.getIssue(options, preview.issue.number);
    previousState = assertReleaseState(issue, options);
    const itemId = await dependencies.findIssueProjectItem(
      options,
      issue,
      project,
    );
    if (!itemId || itemId !== preview.itemId) {
      throw new Error(
        `Issue #${issue.number} Project item changed before release`,
      );
    }
    const snapshot = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    assertOwned(issue, snapshot, options.claimId);
    if (!sameOwnership(snapshot, preview.ownership)) {
      throw ownershipConflict(
        issue,
        options.claimId,
        snapshot.claimId,
        `Issue #${issue.number} ownership snapshot changed before release`,
      );
    }
    await assertReleaseProof(options, issue, snapshot, dependencies);

    const current = await dependencies.getIssue(options, issue.number);
    assertReleaseState(current, options);
    const currentOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    assertOwned(current, currentOwnership, options.claimId);
    if (!sameOwnership(currentOwnership, snapshot)) {
      throw ownershipConflict(
        current,
        options.claimId,
        currentOwnership.claimId,
        `Issue #${issue.number} ownership changed before release mutation`,
      );
    }
    await assertReleaseProof(options, current, snapshot, dependencies);

    mutationAttempted = true;
    await dependencies.editIssueLabels(options, current, options.releaseState);
    await assertReleaseProof(options, current, snapshot, dependencies);
    const ownershipBeforeClear = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    assertExactClaimOwnership(
      current,
      ownershipBeforeClear,
      snapshot,
      "before release metadata write",
    );
    await writeProjectOwnershipMetadata(
      options,
      project,
      itemId,
      current,
      options.releaseState,
      ownershipBeforeClear,
      EMPTY_OWNERSHIP,
      {
        readOwnership: dependencies.readClaimOwnership,
        updateMetadata: dependencies.updateProjectMetadata,
      },
      capability,
      "release",
    );
    await assertReleaseProof(options, current, snapshot, dependencies);
    if (options.dryRun) {
      return {
        number: current.number,
        title: current.title,
        state: options.releaseState,
      };
    }
    const verifiedIssue = await dependencies.getIssue(options, issue.number);
    const verifiedOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    await assertReleaseProof(options, verifiedIssue, snapshot, dependencies);
    if (
      !matchesReleasedState(verifiedIssue, options.releaseState) ||
      !sameOwnership(verifiedOwnership, EMPTY_OWNERSHIP)
    ) {
      throw new Error(
        `Issue #${issue.number} release verification did not retain the requested state with cleared ownership`,
      );
    }
    try {
      await dependencies.commentOnIssue(
        options,
        verifiedIssue,
        buildReleaseComment(verifiedIssue, options.releaseState, options),
      );
    } catch (commentError) {
      const message =
        commentError instanceof Error
          ? commentError.message
          : String(commentError);
      process.stderr.write(
        `Issue #${issue.number} released, but its release comment failed: ${message}\n`,
      );
    }
    return {
      number: verifiedIssue.number,
      title: verifiedIssue.title,
      state: options.releaseState,
    };
  } catch (err) {
    if (err instanceof IssueOwnerMutationCapabilityError) throw err;
    if (!mutationAttempted) {
      lease.markSafeToUnlock("release rejected before mutation");
      throw err;
    }
    try {
      const recovery = await restoreFailedRelease(
        options,
        project,
        preview.itemId,
        issue,
        previousState,
        preview.ownership,
        dependencies,
        capability,
      );
      lease.markSafeToUnlock(
        recovery.preserved
          ? recovery.state === options.releaseState
            ? `applied ${recovery.state} release state preserved`
            : `newer ${recovery.state} release state preserved`
          : "release recovery verified",
      );
    } catch (compensationError) {
      const message = err instanceof Error ? err.message : String(err);
      const compensationMessage =
        compensationError instanceof Error
          ? compensationError.message
          : String(compensationError);
      throw new AggregateError(
        [err, compensationError],
        `${message}\nFailed to establish a stable non-ready recovery state after release: ${compensationMessage}`,
        { cause: compensationError },
      );
    }
    throw err;
  }
}

export async function release(options, overrides = {}) {
  if (options.issues.length === 0) {
    throw new Error("release requires --issue/--issues");
  }
  if (!options.claimId) {
    throw new Error(
      "release requires --claim-id from the claim output or comment",
    );
  }
  if (options.mergedPr && options.closedUnmergedPr) {
    throw new Error(
      "--merged-pr and --closed-unmerged-pr are mutually exclusive",
    );
  }
  if (options.mergedPr && options.releaseState !== "grooming") {
    throw new Error("--merged-pr requires --needs-grooming");
  }
  const dependencies = dependenciesFor(overrides);
  const project = await dependencies.getProject(options);
  requireOwnershipFields(project);
  const results = [];
  for (const number of options.issues) {
    const issue = await dependencies.getIssue(options, number);
    const itemId = await dependencies.findIssueProjectItem(
      options,
      issue,
      project,
    );
    if (!itemId) {
      throw new Error(
        `Issue #${issue.number} has no Project item carrying Claim ID ${options.claimId}`,
      );
    }
    const ownership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    assertOwned(issue, ownership, options.claimId);
    results.push(
      await dependencies.withIssueMutationLock(
        options,
        number,
        {
          operation: "release",
          projectId: project.id,
          agent: ownership.agent ?? options.agent,
          claimId: options.claimId,
          branch: ownership.branch,
          claimedAt: ownership.claimedAt,
          pr: ownership.pr,
        },
        (lease, capability) =>
          releaseLocked(
            options,
            project,
            { issue, itemId, ownership },
            dependencies,
            lease,
            capability,
          ),
      ),
    );
  }
  return results;
}
