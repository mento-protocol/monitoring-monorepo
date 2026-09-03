/**
 * Per-issue mutex adapter for issue-board sync.
 *
 * It enriches the lock payload from known Project ownership and records the
 * first possible sync mutation. A pre-mutation failure can release the mutex;
 * a later uncertain failure leaves its LOCK for operator recovery.
 */

import { readClaimOwnership } from "./issue-board-ownership.mjs";
import {
  ISSUE_STATE_LABELS,
  labelNames,
  labelsForState,
  stateFromLabels,
} from "./issue-board-state.mjs";

export async function preflightStableSyncIssue(
  options,
  project,
  listedIssue,
  operations,
) {
  // A complete enumeration snapshot decides the no-op skip without a read. A
  // change after enumeration defers that issue to the next run; every mutation
  // still re-reads under the mutex.
  const issue =
    listedIssue.projectItemsPageInfo?.hasNextPage === false
      ? listedIssue
      : await operations.getIssue(options, listedIssue.number);
  if (String(issue.state ?? "").toUpperCase() !== "OPEN") return null;
  const state = stateFromLabels(issue);
  if (!state || state === "done") return null;
  const labels = labelNames(issue);
  const queueLabels = ISSUE_STATE_LABELS.filter((label) => labels.has(label));
  const expectedLabels = labelsForState(state).addLabels;
  if (
    queueLabels.length !== expectedLabels.length ||
    !expectedLabels.every((label) => queueLabels.includes(label))
  ) {
    return null;
  }
  const itemId = await operations.findIssueProjectItem(options, issue, project);
  if (!itemId) return null;
  return { number: issue.number, title: issue.title, state };
}

export async function readIssueLockOwnership(
  options,
  project,
  issue,
  operations,
) {
  const itemId = await operations.findIssueProjectItem(options, issue, project);
  if (!itemId) return null;
  return operations.readClaimOwnership(options, project, itemId);
}

function trackSyncMutations(operations, markAttempted) {
  const tracked = { ...operations };
  for (const name of [
    "addIssueLabels",
    "editIssueLabels",
    "ensureProjectItem",
  ]) {
    tracked[name] = (...args) => {
      markAttempted();
      return operations[name](...args);
    };
  }
  return tracked;
}

export async function runLockedSyncIssue(
  options,
  project,
  listedIssue,
  operations,
  syncIssue,
) {
  const ownership = await operations.readIssueLockOwnership(
    options,
    project,
    listedIssue,
    operations,
  );
  return operations.withIssueMutationLock(
    options,
    listedIssue.number,
    {
      operation: "sync",
      projectId: project.id,
      agent: ownership?.agent ?? options.agent,
      claimId: ownership?.claimId ?? null,
      branch: ownership?.branch ?? null,
      claimedAt: ownership?.claimedAt ?? null,
      pr: ownership?.pr ?? null,
    },
    async (lease, _capability) => {
      let mutationAttempted = false;
      const tracked = trackSyncMutations(operations, () => {
        mutationAttempted = true;
      });
      try {
        return await syncIssue(options, project, listedIssue, tracked);
      } catch (err) {
        if (!mutationAttempted) {
          lease.markSafeToUnlock("sync rejected before mutation");
        }
        throw err;
      }
    },
  );
}

export { readClaimOwnership };
