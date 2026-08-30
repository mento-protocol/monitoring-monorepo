/**
 * Issue-board review, backfill, and result-rendering commands.
 *
 * Claim and release transactions live in their scoped modules. Review uses the
 * label and ownership transition. Project Status remains human-owned. Backfill
 * uses the trusted comment parser.
 */

import {
  exactQueueState,
  IssueOwnershipConflictError,
  isReviewable,
  labelNames,
  splitRepo,
} from "./issue-board-state.mjs";
import {
  findIssueProjectItem,
  getProject,
  readBackfillProjectFields,
  requireBackfillFields,
  updateProjectMetadata as writeProjectMetadata,
  writeBackfillProjectFields,
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
  getPrIssues,
  listIssueComments,
  listOpenPullRequestsForBranch,
} from "./issue-board-transport.mjs";
import { backfillIssue } from "./issue-board-backfill.mjs";
import { release } from "./issue-board-release.mjs";
import { buildClaimComment, claim } from "./issue-board-transactions.mjs";

export { buildClaimComment, claim, release };

function sameOwnership(left, right) {
  return ["claimId", "agent", "branch", "claimedAt", "pr"].every(
    (field) => left[field] === right[field],
  );
}

const EMPTY_OWNERSHIP = Object.freeze({
  claimId: null,
  agent: null,
  branch: null,
  claimedAt: null,
  pr: null,
});

function isReviewState(issue) {
  const labels = labelNames(issue);
  return (
    String(issue.state ?? "").toUpperCase() === "OPEN" &&
    labels.has("in-pr") &&
    !labels.has("agent-active") &&
    !labels.has("agent-ready") &&
    !labels.has("needs-grooming")
  );
}

function validateReviewPr(options, pr) {
  const canonicalRepo = splitRepo(options.repo).nameWithOwner.toLowerCase();
  if (
    pr.state !== "OPEN" ||
    !pr.headRefName ||
    pr.headRepository?.nameWithOwner?.toLowerCase() !== canonicalRepo
  ) {
    throw new Error(
      `PR #${options.pr} must be open from ${options.repo} with a named head branch`,
    );
  }
  return pr;
}

async function assertReviewProof(
  options,
  issueNumber,
  previousOwnership,
  targetBranch,
  dependencies,
) {
  const pr = validateReviewPr(
    options,
    await dependencies.getPullRequest(options, options.pr),
  );
  if (pr.headRefName !== targetBranch) {
    throw new Error(
      `PR #${options.pr} head changed from ${targetBranch} to ${pr.headRefName}`,
    );
  }
  if (options.rebindBranch) {
    const oldBranchPrs = await dependencies.listOpenPullRequestsForBranch(
      options,
      previousOwnership.branch,
    );
    if (oldBranchPrs.length > 0) {
      throw new Error(
        `Issue #${issueNumber} cannot rebind while claimed branch ${previousOwnership.branch} has open PR #${oldBranchPrs[0].number}`,
      );
    }
  }
  return pr;
}

function buildReviewComment(metadata, issue) {
  const lines = [
    `Moved to review: #${issue.number} is now represented by PR #${metadata.pr}.`,
  ];
  if (metadata.branch) lines.push(`Branch: ${metadata.branch}`);
  return lines.join("\n");
}

async function restoreFailedReview(
  options,
  project,
  issue,
  itemId,
  previousOwnership,
  nextOwnership,
  dependencies,
) {
  const currentIssue = await dependencies.getIssue(options, issue.number);
  const currentState = exactQueueState(currentIssue);
  if (!currentState || currentState === "ready") {
    throw new Error(
      `Issue #${issue.number} has no exact non-ready state for review recovery`,
    );
  }
  const currentOwnership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  const isPreviousEndpoint =
    currentState === "active" &&
    sameOwnership(currentOwnership, previousOwnership);
  const isNextEndpoint =
    currentState === "review" && sameOwnership(currentOwnership, nextOwnership);
  const isExternalState =
    currentState === "grooming" &&
    sameOwnership(currentOwnership, EMPTY_OWNERSHIP);
  if (!isPreviousEndpoint && !isNextEndpoint && !isExternalState) {
    throw new IssueOwnershipConflictError(
      `Issue #${issue.number} review recovery is ambiguous at ${currentState} with partial or changed ownership`,
      {
        issue: issue.number,
        expected: [previousOwnership, nextOwnership],
        actual: currentOwnership,
      },
    );
  }
  if (isNextEndpoint) {
    await assertReviewProof(
      options,
      issue.number,
      previousOwnership,
      nextOwnership.branch,
      dependencies,
    );
  }
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
      `Issue #${issue.number} review recovery state changed during verification`,
    );
  }
  if (isNextEndpoint) {
    await assertReviewProof(
      options,
      issue.number,
      previousOwnership,
      nextOwnership.branch,
      dependencies,
    );
  }
  return { state: currentState, preserved: !isPreviousEndpoint };
}

async function reviewLocked(
  options,
  project,
  number,
  preview,
  metadata,
  dependencies,
  lease,
  capability,
) {
  let mutationAttempted = false;
  let issue = preview.issue;
  try {
    issue = await dependencies.getIssue(options, number);
    if (!isReviewable(issue)) {
      throw new Error(
        `Issue #${issue.number} is not reviewable; expected open agent-active without agent-ready/in-pr`,
      );
    }
    const itemId = await dependencies.findIssueProjectItem(
      options,
      issue,
      project,
    );
    const ownership = itemId
      ? await dependencies.readClaimOwnership(options, project, itemId)
      : null;
    if (
      itemId !== preview.itemId ||
      !ownership ||
      !sameOwnership(ownership, preview.ownership)
    ) {
      throw new IssueOwnershipConflictError(
        `Issue #${number} ownership changed before review`,
        {
          issue: number,
          expected: preview.ownership,
          actual: ownership,
        },
      );
    }
    await assertReviewProof(
      options,
      number,
      preview.ownership,
      metadata.branch,
      dependencies,
    );

    const currentIssue = await dependencies.getIssue(options, number);
    const currentItemId = await dependencies.findIssueProjectItem(
      options,
      currentIssue,
      project,
    );
    const currentOwnership = currentItemId
      ? await dependencies.readClaimOwnership(options, project, currentItemId)
      : null;
    if (
      !isReviewable(currentIssue) ||
      currentItemId !== itemId ||
      !currentOwnership ||
      !sameOwnership(currentOwnership, preview.ownership)
    ) {
      throw new IssueOwnershipConflictError(
        `Issue #${number} changed before review mutation`,
        {
          issue: number,
          expected: preview.ownership,
          actual: currentOwnership,
        },
      );
    }
    await assertReviewProof(
      options,
      number,
      preview.ownership,
      metadata.branch,
      dependencies,
    );

    mutationAttempted = true;
    await dependencies.editIssueLabels(options, currentIssue, "review");
    await assertReviewProof(
      options,
      number,
      preview.ownership,
      metadata.branch,
      dependencies,
    );
    const ownershipBeforeWrite = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    assertExactClaimOwnership(
      currentIssue,
      ownershipBeforeWrite,
      preview.ownership,
      "before review metadata write",
    );
    await writeProjectOwnershipMetadata(
      options,
      project,
      itemId,
      currentIssue,
      "review",
      ownershipBeforeWrite,
      { branch: metadata.branch, pr: metadata.pr },
      {
        readOwnership: dependencies.readClaimOwnership,
        updateMetadata: dependencies.updateProjectMetadata,
      },
      capability,
      "review",
    );
    await assertReviewProof(
      options,
      number,
      preview.ownership,
      metadata.branch,
      dependencies,
    );

    if (options.dryRun) {
      return { number: issue.number, title: issue.title, state: "review" };
    }
    const verifiedOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      itemId,
    );
    const verifiedIssue = await dependencies.getIssue(options, number);
    await assertReviewProof(
      options,
      number,
      preview.ownership,
      metadata.branch,
      dependencies,
    );
    if (!sameOwnership(verifiedOwnership, metadata)) {
      throw new IssueOwnershipConflictError(
        `Issue #${number} review ownership verification failed`,
        {
          issue: number,
          expected: metadata,
          actual: verifiedOwnership,
        },
      );
    }
    if (!isReviewState(verifiedIssue)) {
      throw new Error(
        `Issue #${number} did not retain the exact in-pr review state`,
      );
    }
    try {
      await dependencies.commentOnIssue(
        options,
        verifiedIssue,
        buildReviewComment(metadata, verifiedIssue),
      );
    } catch (commentError) {
      const message =
        commentError instanceof Error
          ? commentError.message
          : String(commentError);
      process.stderr.write(
        `Issue #${issue.number} moved to review, but its review comment failed: ${message}\n`,
      );
    }
    return {
      number: verifiedIssue.number,
      title: verifiedIssue.title,
      state: "review",
    };
  } catch (err) {
    if (err instanceof IssueOwnerMutationCapabilityError) throw err;
    if (!mutationAttempted) {
      lease.markSafeToUnlock("review rejected before mutation");
      throw err;
    }
    try {
      const recovery = await restoreFailedReview(
        options,
        project,
        issue,
        preview.itemId,
        preview.ownership,
        metadata,
        dependencies,
      );
      lease.markSafeToUnlock(
        recovery.preserved
          ? recovery.state === "review"
            ? "applied review state preserved"
            : `newer ${recovery.state} review state preserved`
          : "review pre-state verified",
      );
    } catch (compensationError) {
      const message = err instanceof Error ? err.message : String(err);
      const compensationMessage =
        compensationError instanceof Error
          ? compensationError.message
          : String(compensationError);
      throw new AggregateError(
        [err, compensationError],
        `${message}\nFailed to establish a stable non-ready recovery state after review: ${compensationMessage}`,
        { cause: compensationError },
      );
    }
    throw err;
  }
}

export async function review(options, overrides = {}) {
  if (!options.pr) {
    throw new Error(
      "review requires --pr so reviewed issues are linked to a pull request",
    );
  }
  if (options.rebindBranch && !options.claimId) {
    throw new Error("--rebind-branch requires --claim-id");
  }
  const dependencies = {
    commentOnIssue: overrides.commentOnIssue ?? commentOnIssue,
    editIssueLabels: overrides.editIssueLabels ?? editIssueLabels,
    findIssueProjectItem:
      overrides.findIssueProjectItem ?? findIssueProjectItem,
    getIssue: overrides.getIssue ?? getIssue,
    getPullRequest: overrides.getPullRequest ?? getPullRequest,
    getPrIssues: overrides.getPrIssues ?? getPrIssues,
    getProject: overrides.getProject ?? getProject,
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
  const project = await dependencies.getProject(options);
  requireOwnershipFields(project);
  const inferredIssues =
    options.issues.length > 0 ? [] : await dependencies.getPrIssues(options);
  const issueNumbers =
    options.issues.length > 0 ? options.issues : inferredIssues;
  if (issueNumbers.length === 0) {
    throw new Error(
      "review requires --issue/--issues or a PR with closing issues",
    );
  }
  const results = [];
  for (const number of issueNumbers) {
    const previewIssue = await dependencies.getIssue(options, number);
    const previewItemId = await dependencies.findIssueProjectItem(
      options,
      previewIssue,
      project,
    );
    if (!previewItemId) {
      throw new Error(`Issue #${number} has no Project ownership item`);
    }
    const previewOwnership = await dependencies.readClaimOwnership(
      options,
      project,
      previewItemId,
    );
    if (
      !previewOwnership.claimId ||
      !previewOwnership.agent ||
      !previewOwnership.branch
    ) {
      throw new Error(
        `Issue #${number} review requires durable Claim ID, Agent, and Branch ownership`,
      );
    }
    if (options.rebindBranch && previewOwnership.claimId !== options.claimId) {
      throw new IssueOwnershipConflictError(
        `Issue #${number} is owned by project Claim ID ${previewOwnership.claimId} instead of ${options.claimId}`,
        {
          issue: number,
          expectedClaimId: options.claimId,
          actualClaimId: previewOwnership.claimId,
        },
      );
    }
    const previewPr = validateReviewPr(
      options,
      await dependencies.getPullRequest(options, options.pr),
    );
    if (
      !options.rebindBranch &&
      previewPr.headRefName !== previewOwnership.branch
    ) {
      throw new Error(
        `PR #${options.pr} head ${previewPr.headRefName} does not match claimed branch ${previewOwnership.branch}; use --claim-id ${previewOwnership.claimId} --rebind-branch only after proving the branch move`,
      );
    }
    if (
      options.rebindBranch &&
      previewPr.headRefName === previewOwnership.branch
    ) {
      throw new Error(
        `Issue #${number} already owns PR head branch ${previewOwnership.branch}; --rebind-branch requires a different proven PR head`,
      );
    }
    const metadata = {
      agent: previewOwnership.agent,
      branch: previewPr.headRefName,
      claimId: previewOwnership.claimId,
      claimedAt: previewOwnership.claimedAt,
      pr: options.pr,
    };
    results.push(
      await dependencies.withIssueMutationLock(
        options,
        number,
        {
          operation: "review",
          projectId: project.id,
          ...metadata,
          previousBranch: options.rebindBranch ? previewOwnership.branch : null,
          previousPr: options.rebindBranch ? previewOwnership.pr : null,
        },
        (lease, capability) =>
          reviewLocked(
            options,
            project,
            number,
            {
              issue: previewIssue,
              itemId: previewItemId,
              ownership: previewOwnership,
            },
            metadata,
            dependencies,
            lease,
            capability,
          ),
      ),
    );
  }
  return results;
}

export async function backfill(options, dependencies = {}) {
  const operations = {
    getIssue: dependencies.getIssue ?? getIssue,
    getProject: dependencies.getProject ?? getProject,
    findIssueProjectItem:
      dependencies.findIssueProjectItem ?? findIssueProjectItem,
    listIssueComments: dependencies.listIssueComments ?? listIssueComments,
    requireBackfillFields:
      dependencies.requireBackfillFields ?? requireBackfillFields,
    readBackfillProjectFields:
      dependencies.readBackfillProjectFields ?? readBackfillProjectFields,
    readClaimOwnership: dependencies.readClaimOwnership ?? readClaimOwnership,
    writeBackfillProjectFields:
      dependencies.writeBackfillProjectFields ??
      ((options, project, itemId, writes, capability, issue) =>
        writeBackfillProjectFields(
          capability,
          options,
          project,
          itemId,
          writes,
          { issueNumber: issue.number, operation: "backfill" },
        )),
  };
  const lock = dependencies.withIssueMutationLock ?? withIssueMutationLock;
  const previewIssue = await operations.getIssue(options, options.issues[0]);
  const previewProject = await operations.getProject(options);
  const previewItemId = await operations.findIssueProjectItem(
    options,
    previewIssue,
    previewProject,
  );
  const ownership = previewItemId
    ? await operations.readClaimOwnership(
        options,
        previewProject,
        previewItemId,
      )
    : null;
  return [
    await lock(
      options,
      options.issues[0],
      {
        operation: "backfill",
        projectId: previewProject.id,
        agent: ownership?.agent ?? options.agent,
        claimId: ownership?.claimId ?? null,
        branch: ownership?.branch ?? null,
        claimedAt: ownership?.claimedAt ?? null,
        pr: ownership?.pr ?? null,
      },
      (lease, capability) =>
        backfillIssue(options, operations, lease, capability),
    ),
  ];
}

export function renderResults(results) {
  if (results.length === 0) return "No issues changed.";
  return results
    .map((issue) => {
      const writes = issue.writes
        ?.map((write) => `${write.field}=${write.value}`)
        .join(", ");
      const details = [
        writes,
        issue.claimId ? `Claim ID: ${issue.claimId}` : null,
        issue.recovered ? "recovered" : null,
      ].filter(Boolean);
      return `#${issue.number} ${issue.state}: ${issue.title}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
    })
    .join("\n");
}
