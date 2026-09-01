/**
 * Owner-aware claim transactions for the issue board.
 *
 * Claims reserve a stable owner token before their final eligibility read and
 * never compensate a partial failure to ready.
 */

import { randomUUID } from "node:crypto";

import {
  chooseUntriedCandidate,
  exactQueueState,
  hasSweepClaimAttributes,
  issueBodySha256,
  ISSUE_STATE_LABELS,
  IssueClaimCandidateLossError,
  IssueOwnershipConflictError,
  isActiveSweepClaim,
  isClaimable,
  isRecoverableClaimRaceError,
  isReviewable,
  isSweepClaimable,
  labelNames,
  OPTIONAL_PROJECT_FIELDS,
  projectDateFieldValue,
  validateClaimAgent,
  validateClaimBranch,
  stateFromLabels,
  validateClaimId,
  validateIssueBodySha256,
} from "./issue-board-state.mjs";
import {
  ensureProjectItem,
  findIssueProjectItem,
  getProject,
  readProjectItemStatus,
  updateProjectMetadata as writeProjectMetadata,
} from "./issue-board-projects.mjs";
import {
  planClaimOwnershipReservation,
  planClaimOwnershipMetadataWrite,
  readClaimOwnership,
  requireOwnershipFields,
  reserveClaimOwnership,
  verifyClaimOwnership,
  writeProjectOwnershipMetadata,
} from "./issue-board-ownership.mjs";
import {
  IssueOwnerMutationCapabilityError,
  IssueMutationLockStaleError,
  withIssueMutationLock,
} from "./issue-board-lock.mjs";
import { parseClaimComment } from "./issue-board-backfill.mjs";
import {
  commentOnIssue,
  editIssueLabels,
  getGitBranch,
  getIssue,
  listIssueComments,
  listReadyIssues,
  removeIssueLabels,
  sleep,
} from "./issue-board-transport.mjs";

const CLAIM_SETTLE_MS = 1500;

function claimCommentTimestamp(claimedAt) {
  const value = String(claimedAt ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function buildClaimComment(metadata, issue) {
  const agent = validateClaimAgent(metadata.agent);
  const branch =
    metadata.branch == null || metadata.branch === ""
      ? null
      : validateClaimBranch(metadata.branch);
  const claimId = validateClaimId(metadata.claimId);
  const lines = [
    `Agent claim: ${agent} claimed #${issue.number} for implementation.`,
    "",
    `Claim ID: ${claimId}`,
  ];
  if (branch != null) lines.push(`Branch: ${branch}`);
  lines.push(`Claimed at: ${claimCommentTimestamp(metadata.claimedAt)}`);
  return lines.join("\n");
}

function hasMatchingTrustedClaimComment(comments, issue, metadata) {
  return comments.some((comment) => {
    const parsed = parseClaimComment(comment, issue.number);
    return (
      parsed?.metadata[OPTIONAL_PROJECT_FIELDS.agent] === metadata.agent &&
      parsed.metadata[OPTIONAL_PROJECT_FIELDS.claimId] === metadata.claimId &&
      parsed.branch === (metadata.branch ?? null) &&
      parsed.metadata[OPTIONAL_PROJECT_FIELDS.claimedAt] ===
        projectDateFieldValue(metadata.claimedAt)
    );
  });
}

async function ensureMatchingTrustedClaimComment(
  options,
  issue,
  metadata,
  dependencies,
) {
  if (!options.comment || options.dryRun) return;
  const comments = await dependencies.listIssueComments(options, issue.number);
  if (hasMatchingTrustedClaimComment(comments, issue, metadata)) return;
  await dependencies.commentOnIssue(
    options,
    issue,
    buildClaimComment(metadata, issue),
  );
  const refreshedComments = await dependencies.listIssueComments(
    options,
    issue.number,
  );
  if (!hasMatchingTrustedClaimComment(refreshedComments, issue, metadata)) {
    throw new Error(
      `Issue #${issue.number} claim comment was not confirmed as a trusted parseable claim after posting`,
    );
  }
}

function claimIdFor(options) {
  return validateClaimId(options.claimId ?? `claim-${randomUUID()}`);
}

function claimMetadata(options, branch, now) {
  if (!branch) {
    throw new Error(
      "claim requires --branch or a checked-out branch so ownership has a durable Branch value",
    );
  }
  return {
    agent: validateClaimAgent(options.agent),
    branch: validateClaimBranch(branch),
    claimId: claimIdFor(options),
    claimedAt: now.toISOString(),
    pr: null,
  };
}

function commandDependencies(overrides = {}) {
  return {
    commentOnIssue: overrides.commentOnIssue ?? commentOnIssue,
    editIssueLabels: overrides.editIssueLabels ?? editIssueLabels,
    ensureProjectItem: overrides.ensureProjectItem ?? ensureProjectItem,
    findIssueProjectItem:
      overrides.findIssueProjectItem ?? findIssueProjectItem,
    getGitBranch: overrides.getGitBranch ?? getGitBranch,
    getIssue: overrides.getIssue ?? getIssue,
    listIssueComments: overrides.listIssueComments ?? listIssueComments,
    getProject: overrides.getProject ?? getProject,
    listReadyIssues: overrides.listReadyIssues ?? listReadyIssues,
    now: overrides.now ?? (() => new Date()),
    readClaimOwnership: overrides.readClaimOwnership ?? readClaimOwnership,
    readProjectItemStatus:
      overrides.readProjectItemStatus ?? readProjectItemStatus,
    removeIssueLabels: overrides.removeIssueLabels ?? removeIssueLabels,
    reserveClaimOwnership:
      overrides.reserveClaimOwnership ??
      ((options, project, itemId, issue, metadata, capability) =>
        reserveClaimOwnership(
          options,
          project,
          itemId,
          issue,
          metadata,
          {},
          capability,
        )),
    sleep: overrides.sleep ?? sleep,
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
    verifyClaimOwnership:
      overrides.verifyClaimOwnership ?? verifyClaimOwnership,
    withIssueMutationLock:
      overrides.withIssueMutationLock ?? withIssueMutationLock,
  };
}

function sameProjectStatus(left, right) {
  return (
    left?.name === right?.name &&
    left?.optionId === right?.optionId &&
    left?.name != null &&
    left?.optionId != null
  );
}

function assertUnblockedSweepStatus(issue, status, phase) {
  if (!status?.name || !status?.optionId) {
    throw new IssueClaimCandidateLossError(
      `Issue #${issue.number} sweep claim cannot prove the selected Project Status during ${phase}`,
    );
  }
  if (status.name === "Blocked") {
    throw new IssueClaimCandidateLossError(
      `Issue #${issue.number} became Project Blocked during ${phase}`,
    );
  }
  return status;
}

async function readSweepStatus(
  options,
  project,
  itemId,
  issue,
  dependencies,
  phase,
) {
  if (!project.id || !project.statusField?.id) {
    throw new IssueClaimCandidateLossError(
      `Issue #${issue.number} sweep claim cannot bind the selected Project and Status field during ${phase}`,
    );
  }
  return assertUnblockedSweepStatus(
    issue,
    await dependencies.readProjectItemStatus(options, project, itemId),
    phase,
  );
}

async function assertSweepStatusUnchanged(
  options,
  project,
  itemId,
  issue,
  expected,
  dependencies,
  phase,
) {
  const actual = await readSweepStatus(
    options,
    project,
    itemId,
    issue,
    dependencies,
    phase,
  );
  if (!sameProjectStatus(actual, expected)) {
    throw new IssueClaimCandidateLossError(
      `Issue #${issue.number} selected Project Status changed during ${phase}; expected ${expected.name}/${expected.optionId}, observed ${actual.name}/${actual.optionId}`,
    );
  }
  return actual;
}

function claimabilityError(options, issue) {
  if (options.sweepEligible) {
    return new IssueClaimCandidateLossError(
      `Issue #${issue.number} is not sweep-eligible; expected open agent-ready, exactly risk:low, exactly one pkg:* label, no native blocker, and an exact non-Blocked selected Project Status`,
    );
  }
  return new IssueClaimCandidateLossError(
    `Issue #${issue.number} is not claimable; expected open agent-ready without agent-active/in-pr/needs-grooming`,
  );
}

function isEligibleClaim(options, issue, project) {
  return options.sweepEligible
    ? isSweepClaimable(issue, project)
    : isClaimable(issue);
}

function isHeldClaim(options, issue, project) {
  return options.sweepEligible
    ? isActiveSweepClaim(issue, project)
    : isReviewable(issue);
}

function assertSweepBodyUnchanged(options, issue, phase) {
  if (!options.sweepEligible) return;
  const expected = validateIssueBodySha256(options.bodySha256);
  const actual = issueBodySha256(issue.body);
  if (actual !== expected) {
    throw new IssueClaimCandidateLossError(
      `Issue #${issue.number} body changed after the orchestrator's eligibility read during ${phase}; expected SHA-256 ${expected}, observed ${actual}`,
    );
  }
}

function withClaimId(err, claimId) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(`Claim ID: ${claimId}`)) return err;
  if (err instanceof IssueMutationLockStaleError) {
    return new IssueMutationLockStaleError(
      `${message}\nClaim ID: ${claimId}`,
      err.lease,
      { cause: err },
    );
  }
  return new Error(`${message}\nClaim ID: ${claimId}`, { cause: err });
}

async function ensurePartialClaimIsNotReady(
  options,
  project,
  itemId,
  issue,
  metadata,
  dependencies,
  lease,
  capability,
) {
  if (options.dryRun) {
    return { safe: true, state: "dry-run", ownership: "unverified" };
  }
  if (
    lease?.payload?.operation !== "claim" ||
    lease.payload.claimId !== metadata.claimId
  ) {
    throw new Error("partial-claim quarantine requires the owned claim mutex");
  }

  let ownedItemId = itemId;
  let ownershipDisposition = "missing";
  if (!ownedItemId) {
    try {
      ownedItemId = await dependencies.findIssueProjectItem(
        options,
        issue,
        project,
      );
    } catch {
      ownedItemId = null;
    }
  }

  if (ownedItemId) {
    let ownership = null;
    let ownershipRead = false;
    try {
      ownership = await dependencies.readClaimOwnership(
        options,
        project,
        ownedItemId,
      );
      ownershipRead = true;
    } catch {
      ownershipDisposition = "unreadable";
    }
    if (ownershipRead && ownership?.claimId === metadata.claimId) {
      ownershipDisposition = ownership.branch ? "ours" : "ours-missing-branch";
      try {
        const plannedOwnership = planClaimOwnershipReservation(
          issue,
          ownership,
          metadata,
        );
        const current = await dependencies.getIssue(options, issue.number);
        if (String(current.state ?? "").toUpperCase() !== "OPEN") {
          return { safe: true, state: "closed", ownership: "ours" };
        }
        const queueState = exactQueueState(current);
        if (queueState !== "ready" && queueState !== "active") {
          throw new Error("partial claim has a newer non-ready state");
        }
        if (
          options.sweepEligible &&
          queueState === "ready" &&
          !isEligibleClaim(options, current, project)
        ) {
          throw claimabilityError(options, current);
        }
        const sweepStatus = options.sweepEligible
          ? await readSweepStatus(
              options,
              project,
              ownedItemId,
              issue,
              dependencies,
              "partial-claim pre-transition check",
            )
          : null;
        if (queueState === "ready") {
          await dependencies.editIssueLabels(options, current, "active");
        }
        if (options.sweepEligible) {
          await assertSweepStatusUnchanged(
            options,
            project,
            ownedItemId,
            issue,
            sweepStatus,
            dependencies,
            "partial-claim post-label check",
          );
        }
        const reservation = await dependencies.reserveClaimOwnership(
          options,
          project,
          ownedItemId,
          issue,
          metadata,
          capability,
        );
        if (options.sweepEligible) {
          await assertSweepStatusUnchanged(
            options,
            project,
            ownedItemId,
            issue,
            sweepStatus,
            dependencies,
            "partial-claim post-reservation check",
          );
        }
        const writePlan = options.dryRun
          ? (reservation ?? plannedOwnership)
          : await planClaimOwnershipMetadataWrite(
              options,
              project,
              ownedItemId,
              issue,
              metadata,
              { readOwnership: dependencies.readClaimOwnership },
            );
        await writeProjectOwnershipMetadata(
          options,
          project,
          ownedItemId,
          issue,
          "active",
          writePlan.ownership,
          writePlan.missingMetadata,
          {
            readOwnership: dependencies.readClaimOwnership,
            updateMetadata: dependencies.updateProjectMetadata,
          },
          capability,
          "claim",
        );
        if (options.sweepEligible) {
          await assertSweepStatusUnchanged(
            options,
            project,
            ownedItemId,
            issue,
            sweepStatus,
            dependencies,
            "partial-claim post-metadata check",
          );
        }
        await dependencies.verifyClaimOwnership(
          options,
          project,
          ownedItemId,
          issue,
          metadata,
        );
        const verifiedOwnership = await dependencies.readClaimOwnership(
          options,
          project,
          ownedItemId,
        );
        const verified = await dependencies.getIssue(options, issue.number);
        if (
          verifiedOwnership.claimId === metadata.claimId &&
          isHeldClaim(options, verified, project)
        ) {
          return { safe: true, state: "active", ownership: "ours" };
        }
      } catch (recoveryError) {
        if (recoveryError instanceof IssueOwnerMutationCapabilityError) {
          throw recoveryError;
        }
        // The owned LOCK still permits a label-only quarantine below.
        ownershipDisposition = "ours-conflicting";
      }
    } else if (ownershipRead && ownership?.claimId) {
      ownershipDisposition = "foreign";
    } else if (ownershipRead) {
      ownershipDisposition = [
        ownership?.agent,
        ownership?.branch,
        ownership?.claimedAt,
        ownership?.pr,
      ].some((value) => value != null && value !== "")
        ? "partial"
        : "empty";
    }
  }

  const current = await dependencies.getIssue(options, issue.number);
  if (String(current.state ?? "").toUpperCase() !== "OPEN") {
    return {
      safe: true,
      state: "closed",
      ownership: ownershipDisposition,
    };
  }
  const currentLabels = labelNames(current);
  if (!currentLabels.has("agent-ready")) {
    const queueState = exactQueueState(current);
    return {
      safe: queueState != null && queueState !== "ready",
      state: "non-ready",
      ownership: ownershipDisposition,
      queueState: queueState ?? stateFromLabels(current) ?? "unlabelled",
    };
  }
  const newerNonReadyLabels = ISSUE_STATE_LABELS.filter(
    (label) => label !== "agent-ready" && currentLabels.has(label),
  );
  if (newerNonReadyLabels.length > 0) {
    await dependencies.removeIssueLabels(options, current, ["agent-ready"]);
    const verified = await dependencies.getIssue(options, issue.number);
    const queueState = exactQueueState(verified);
    return {
      safe: queueState != null && queueState !== "ready",
      state: "non-ready",
      ownership: ownershipDisposition,
      queueState: queueState ?? stateFromLabels(verified) ?? "conflicting",
    };
  }
  await dependencies.editIssueLabels(options, current, "grooming");
  const verified = await dependencies.getIssue(options, issue.number);
  const safe = exactQueueState(verified) === "grooming";
  if (safe && ownedItemId && ownershipDisposition === "ours-conflicting") {
    try {
      const verifiedOwnership = await dependencies.readClaimOwnership(
        options,
        project,
        ownedItemId,
      );
      if (verifiedOwnership.claimId === metadata.claimId) {
        planClaimOwnershipReservation(issue, verifiedOwnership, metadata);
        ownershipDisposition = verifiedOwnership.branch
          ? "ours"
          : "ours-missing-branch";
      }
    } catch {
      // Keep the conservative disposition when exact ownership is not proven.
    }
  }
  return {
    safe,
    state: "grooming",
    ownership: ownershipDisposition,
  };
}

async function recoverOwnedClaim(
  options,
  project,
  issue,
  metadata,
  dependencies,
  markMutationAttempted,
  capability,
) {
  if (!options.claimId || !isReviewable(issue)) return null;
  const itemId = await dependencies.findIssueProjectItem(
    options,
    issue,
    project,
  );
  if (!itemId) return null;
  const ownership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  if (ownership.claimId !== metadata.claimId) return null;
  if (options.sweepEligible && !hasSweepClaimAttributes(issue, project)) {
    throw claimabilityError(options, issue);
  }
  const plannedOwnership = planClaimOwnershipReservation(
    issue,
    ownership,
    metadata,
  );
  markMutationAttempted();
  const sweepStatus = options.sweepEligible
    ? await readSweepStatus(
        options,
        project,
        itemId,
        issue,
        dependencies,
        "same-token recovery",
      )
    : null;
  const reservation = await dependencies.reserveClaimOwnership(
    options,
    project,
    itemId,
    issue,
    metadata,
    capability,
  );
  const reservedOwnership = await dependencies.readClaimOwnership(
    options,
    project,
    itemId,
  );
  if (reservedOwnership.claimId !== metadata.claimId) {
    throw new IssueOwnershipConflictError(
      `Issue #${issue.number} same-token claim recovery lost Claim ID ${metadata.claimId}`,
      {
        issue: issue.number,
        expectedClaimId: metadata.claimId,
        actualClaimId: reservedOwnership.claimId,
      },
    );
  }
  planClaimOwnershipReservation(issue, reservedOwnership, metadata);
  const recoveryCurrent = options.dryRun
    ? issue
    : await dependencies.getIssue(options, issue.number);
  assertSweepBodyUnchanged(
    options,
    recoveryCurrent,
    "same-token recovery post-reservation check",
  );
  if (
    options.sweepEligible &&
    !hasSweepClaimAttributes(recoveryCurrent, project)
  ) {
    throw claimabilityError(options, recoveryCurrent);
  }
  if (options.sweepEligible) {
    await assertSweepStatusUnchanged(
      options,
      project,
      itemId,
      recoveryCurrent,
      sweepStatus,
      dependencies,
      "same-token recovery pre-write check",
    );
  }
  const writePlan = options.dryRun
    ? (reservation ?? plannedOwnership)
    : await planClaimOwnershipMetadataWrite(
        options,
        project,
        itemId,
        recoveryCurrent,
        metadata,
        { readOwnership: dependencies.readClaimOwnership },
      );
  await writeProjectOwnershipMetadata(
    options,
    project,
    itemId,
    recoveryCurrent,
    "active",
    writePlan.ownership,
    writePlan.missingMetadata,
    {
      readOwnership: dependencies.readClaimOwnership,
      updateMetadata: dependencies.updateProjectMetadata,
    },
    capability,
    "claim",
  );
  if (options.sweepEligible) {
    const recoveryPostMetadata = options.dryRun
      ? recoveryCurrent
      : await dependencies.getIssue(options, issue.number);
    assertSweepBodyUnchanged(
      options,
      recoveryPostMetadata,
      "same-token recovery post-metadata check",
    );
    await assertSweepStatusUnchanged(
      options,
      project,
      itemId,
      recoveryPostMetadata,
      sweepStatus,
      dependencies,
      "same-token recovery post-metadata check",
    );
  }
  await dependencies.verifyClaimOwnership(
    options,
    project,
    itemId,
    issue,
    metadata,
  );
  if (options.sweepEligible && !options.dryRun) {
    await assertSweepStatusUnchanged(
      options,
      project,
      itemId,
      issue,
      sweepStatus,
      dependencies,
      "same-token recovery final check",
    );
  }
  const verified = options.dryRun
    ? issue
    : await dependencies.getIssue(options, issue.number);
  assertSweepBodyUnchanged(
    options,
    verified,
    "same-token recovery final check",
  );
  if (!isHeldClaim(options, verified, project)) {
    throw new Error(
      `Issue #${issue.number} did not retain an eligible agent-active claim`,
    );
  }
  await ensureMatchingTrustedClaimComment(
    options,
    verified,
    metadata,
    dependencies,
  );
  const finalIssue = options.sweepEligible
    ? await dependencies.getIssue(options, issue.number)
    : verified;
  assertSweepBodyUnchanged(
    options,
    finalIssue,
    "same-token recovery final post-comment check",
  );
  if (options.sweepEligible && !options.dryRun) {
    await assertSweepStatusUnchanged(
      options,
      project,
      itemId,
      finalIssue,
      sweepStatus,
      dependencies,
      "same-token recovery final post-comment check",
    );
  }
  if (!isHeldClaim(options, finalIssue, project)) {
    throw new Error(
      `Issue #${issue.number} did not retain an eligible agent-active claim during final recovery check`,
    );
  }
  return {
    number: finalIssue.number,
    title: finalIssue.title,
    state: "active",
    claimId: metadata.claimId,
    recovered: true,
  };
}

async function claimIssue(
  options,
  project,
  number,
  metadata,
  dependencies,
  lease,
  capability,
) {
  let itemId = null;
  let mutationAttempted = false;
  let issue = { number };
  try {
    issue = await dependencies.getIssue(options, number);
    assertSweepBodyUnchanged(options, issue, "initial locked check");
    const recovered = await recoverOwnedClaim(
      options,
      project,
      issue,
      metadata,
      dependencies,
      () => {
        mutationAttempted = true;
      },
      capability,
    );
    if (recovered) return recovered;
    if (!isEligibleClaim(options, issue, project)) {
      throw claimabilityError(options, issue);
    }
    mutationAttempted = true;
    itemId = await dependencies.ensureProjectItem(options, project, issue);
    const sweepStatus =
      options.sweepEligible && !options.dryRun
        ? await readSweepStatus(
            options,
            project,
            itemId,
            issue,
            dependencies,
            "pre-ownership check",
          )
        : null;
    const reservation = await dependencies.reserveClaimOwnership(
      options,
      project,
      itemId,
      issue,
      metadata,
      capability,
    );
    const current = await dependencies.getIssue(options, issue.number);
    assertSweepBodyUnchanged(options, current, "post-reservation check");
    if (!isEligibleClaim(options, current, project)) {
      throw claimabilityError(options, current);
    }
    if (options.sweepEligible && !options.dryRun) {
      await assertSweepStatusUnchanged(
        options,
        project,
        itemId,
        current,
        sweepStatus,
        dependencies,
        "post-reservation check",
      );
    }
    await dependencies.editIssueLabels(options, current, "active");
    const postLabel = options.dryRun
      ? current
      : await dependencies.getIssue(options, issue.number);
    assertSweepBodyUnchanged(options, postLabel, "post-label check");
    if (options.sweepEligible && !options.dryRun) {
      await assertSweepStatusUnchanged(
        options,
        project,
        itemId,
        postLabel,
        sweepStatus,
        dependencies,
        "pre-metadata check",
      );
    }
    const writePlan = options.dryRun
      ? reservation
      : await planClaimOwnershipMetadataWrite(
          options,
          project,
          itemId,
          postLabel,
          metadata,
          { readOwnership: dependencies.readClaimOwnership },
        );
    await writeProjectOwnershipMetadata(
      options,
      project,
      itemId,
      postLabel,
      "active",
      writePlan?.ownership,
      writePlan?.missingMetadata ?? metadata,
      {
        readOwnership: dependencies.readClaimOwnership,
        updateMetadata: dependencies.updateProjectMetadata,
      },
      capability,
      "claim",
    );
    if (options.dryRun) {
      await dependencies.commentOnIssue(
        options,
        issue,
        buildClaimComment(metadata, issue),
      );
      return {
        number: issue.number,
        title: issue.title,
        state: "active",
        claimId: metadata.claimId,
      };
    }
    if (options.sweepEligible) {
      const postMetadata = await dependencies.getIssue(options, issue.number);
      assertSweepBodyUnchanged(options, postMetadata, "post-metadata check");
      await assertSweepStatusUnchanged(
        options,
        project,
        itemId,
        postMetadata,
        sweepStatus,
        dependencies,
        "post-metadata check",
      );
    }
    await dependencies.sleep(CLAIM_SETTLE_MS);
    await dependencies.verifyClaimOwnership(
      options,
      project,
      itemId,
      issue,
      metadata,
    );
    const verified = await dependencies.getIssue(options, issue.number);
    assertSweepBodyUnchanged(options, verified, "post-settle check");
    if (options.sweepEligible) {
      await assertSweepStatusUnchanged(
        options,
        project,
        itemId,
        verified,
        sweepStatus,
        dependencies,
        "post-settle check",
      );
    }
    if (!isHeldClaim(options, verified, project)) {
      throw new Error(
        `Issue #${issue.number} did not retain an eligible agent-active claim`,
      );
    }
    await ensureMatchingTrustedClaimComment(
      options,
      verified,
      metadata,
      dependencies,
    );
    const finalIssue = options.sweepEligible
      ? await dependencies.getIssue(options, issue.number)
      : verified;
    assertSweepBodyUnchanged(options, finalIssue, "final check");
    if (options.sweepEligible) {
      await assertSweepStatusUnchanged(
        options,
        project,
        itemId,
        finalIssue,
        sweepStatus,
        dependencies,
        "final check",
      );
    }
    if (!isHeldClaim(options, finalIssue, project)) {
      throw new Error(
        `Issue #${issue.number} did not retain an eligible agent-active claim during final check`,
      );
    }
    return {
      number: finalIssue.number,
      title: finalIssue.title,
      state: "active",
      claimId: metadata.claimId,
    };
  } catch (err) {
    if (err instanceof IssueOwnerMutationCapabilityError) throw err;
    if (!mutationAttempted) {
      lease.markSafeToUnlock("claim rejected before mutation");
      throw err;
    }
    let partialClaimDisposition;
    try {
      const disposition = await ensurePartialClaimIsNotReady(
        options,
        project,
        itemId,
        issue,
        metadata,
        dependencies,
        lease,
        capability,
      );
      if (disposition.safe) {
        lease.markSafeToUnlock("partial claim retained outside ready");
      }
      partialClaimDisposition = disposition;
    } catch (compensationError) {
      const compensationMessage =
        compensationError instanceof Error
          ? compensationError.message
          : String(compensationError);
      const partialError = new Error(
        `${err instanceof Error ? err.message : String(err)}\nFailed to keep the partial claim out of ready: ${compensationMessage}`,
        { cause: new AggregateError([err, compensationError]) },
      );
      partialError.partialClaim = true;
      throw partialError;
    }
    let partialError = withClaimId(err, metadata.claimId);
    const disposition = partialClaimDisposition;
    if (disposition?.state === "grooming") {
      const recovery = !disposition.safe
        ? "The helper could not verify the needs-grooming quarantine. An operator must inspect the issue and stale lock before any recovery."
        : disposition.ownership === "ours"
          ? `The matching partial claim is quarantined in needs-grooming. Clear it with --claim-id ${metadata.claimId} and --needs-grooming.`
          : `The failed claim is quarantined in needs-grooming with ${disposition.ownership} Project ownership. An operator must inspect the lock payload and clear only proven partial fields.`;
      partialError = new Error(`${partialError.message}\n${recovery}`, {
        cause: partialError,
      });
      partialError.partialClaimDisposition = disposition;
    } else if (disposition?.state === "non-ready") {
      const observed = disposition.queueState ?? "unlabelled";
      const recovery =
        disposition.ownership === "ours"
          ? `The matching partial claim remains non-ready in ${observed}. Retry the same claim token and branch to complete its durable ownership.`
          : `The failed claim remains non-ready in ${observed} with ${disposition.ownership} Project ownership. An operator must inspect it before recovery.`;
      partialError = new Error(`${partialError.message}\n${recovery}`, {
        cause: partialError,
      });
      partialError.partialClaimDisposition = disposition;
    }
    partialError.partialClaim = true;
    throw partialError;
  }
}

function appendCompletedClaims(err, results) {
  const completed = results
    .map((result) => `#${result.number} Claim ID: ${result.claimId}`)
    .join(", ");
  if (!completed) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof IssueMutationLockStaleError) {
    return new IssueMutationLockStaleError(
      `${message}\nCompleted claims: ${completed}`,
      err.lease,
      { cause: err },
    );
  }
  return new Error(`${message}\nCompleted claims: ${completed}`, {
    cause: err,
  });
}

async function claimOne(options, project, number, metadata, dependencies) {
  const prepareMetadata = options.claimId
    ? async (lockMetadata) => {
        const issue = await dependencies.getIssue(options, number);
        const itemId = await dependencies.findIssueProjectItem(
          options,
          issue,
          project,
        );
        if (!itemId) return lockMetadata;
        const ownership = await dependencies.readClaimOwnership(
          options,
          project,
          itemId,
        );
        if (ownership.claimId !== metadata.claimId || !ownership.claimedAt) {
          return lockMetadata;
        }
        metadata.claimedAt = ownership.claimedAt;
        return { ...lockMetadata, claimedAt: ownership.claimedAt };
      }
    : null;
  try {
    return await dependencies.withIssueMutationLock(
      options,
      number,
      { operation: "claim", projectId: project.id, ...metadata },
      (lease, capability) =>
        claimIssue(
          options,
          project,
          number,
          metadata,
          dependencies,
          lease,
          capability,
        ),
      prepareMetadata ? { prepareMetadata } : {},
    );
  } catch (err) {
    throw withClaimId(err, metadata.claimId);
  }
}

export async function claim(options, overrides = {}) {
  if (options.pr != null) {
    throw new Error("--pr is valid only for review");
  }
  const dependencies = commandDependencies(overrides);
  const explicitBranch = String(options.branch ?? "");
  if (options.sweepEligible && options.issues.length !== 1) {
    throw new Error("--sweep-eligible requires exactly one explicit issue");
  }
  if (options.sweepEligible && !options.claimId) {
    throw new Error("--sweep-eligible requires an explicit --claim-id");
  }
  if (options.sweepEligible && !explicitBranch) {
    throw new Error("--sweep-eligible requires an explicit --branch");
  }
  if (options.sweepEligible && !options.bodySha256) {
    throw new Error(
      "--sweep-eligible requires --body-sha256 from the inspected issue body",
    );
  }
  if (options.bodySha256) validateIssueBodySha256(options.bodySha256);
  const branch =
    explicitBranch || String((await dependencies.getGitBranch()) ?? "");
  if (!branch) {
    throw new Error(
      "claim requires --branch or a checked-out branch so ownership has a durable Branch value",
    );
  }
  const claimOptions = {
    ...options,
    agent: validateClaimAgent(options.agent),
  };
  const validatedBranch = validateClaimBranch(branch);
  const project = await dependencies.getProject(claimOptions);
  requireOwnershipFields(project);
  const results = [];
  if (options.issues.length > 0) {
    for (const number of options.issues) {
      const metadata = claimMetadata(
        claimOptions,
        validatedBranch,
        dependencies.now(),
      );
      try {
        results.push(
          await claimOne(claimOptions, project, number, metadata, dependencies),
        );
      } catch (err) {
        throw appendCompletedClaims(err, results);
      }
    }
    return results;
  }

  const triedNumbers = new Set();
  const candidateLimit = Math.min(Math.max(options.count * 5, 10), 100);
  try {
    while (results.length < options.count) {
      const candidates = await dependencies.listReadyIssues({
        ...options,
        count: candidateLimit,
      });
      const candidate = chooseUntriedCandidate(candidates, triedNumbers);
      if (!candidate) break;
      triedNumbers.add(candidate.number);
      const issue = await dependencies.getIssue(options, candidate.number);
      if (!isClaimable(issue)) continue;
      const metadata = claimMetadata(
        claimOptions,
        validatedBranch,
        dependencies.now(),
      );
      try {
        results.push(
          await claimOne(
            claimOptions,
            project,
            issue.number,
            metadata,
            dependencies,
          ),
        );
      } catch (err) {
        if (!isRecoverableClaimRaceError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Skipped #${issue.number}: ${message}\n`);
      }
    }
  } catch (err) {
    throw appendCompletedClaims(err, results);
  }

  if (results.length === 0) {
    throw new Error("No claimable agent-ready issues found");
  }
  return results;
}
