/**
 * Issue-board reconciliation and closeout.
 *
 * Queue labels remain authoritative. This layer projects each observed state
 * onto the workboard and verifies concurrent close, reopen, and label changes.
 */

import {
  ISSUE_STATE_LABELS,
  labelNames,
  labelsForState,
  stateFromLabels,
} from "./issue-board-state.mjs";
import {
  ensureProjectItem,
  findIssueProjectItem,
  getProject,
  updateProjectFields,
} from "./issue-board-projects.mjs";
import {
  addIssueLabels,
  editIssueLabels,
  getIssue,
  listIssuesByLabels,
  sleep,
} from "./issue-board-transport.mjs";

const SYNC_RECONCILE_ATTEMPTS = 3;
const SYNC_COMPENSATE_ATTEMPTS = 3;
const SYNC_VERIFY_ATTEMPTS = 3;
const SYNC_VERIFY_SETTLE_MS = 250;

async function verifySyncCloseout(options, issue, operations) {
  let staleLabels = [];
  for (let attempt = 1; attempt <= SYNC_VERIFY_ATTEMPTS; attempt += 1) {
    const verified = await operations.getIssue(options, issue.number);
    const verifiedState = String(verified.state ?? "").toUpperCase();
    if (verifiedState !== "CLOSED") {
      return verified;
    }
    const verifiedLabels = labelNames(verified);
    staleLabels = ISSUE_STATE_LABELS.filter((label) =>
      verifiedLabels.has(label),
    );
    if (staleLabels.length === 0) return verified;
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

function queueLabelsFromIssue(issue) {
  const labels = labelNames(issue);
  return ISSUE_STATE_LABELS.filter((label) => labels.has(label));
}

function nearestQueueLabels(...issues) {
  for (const issue of issues) {
    const queueLabels = queueLabelsFromIssue(issue);
    if (queueLabels.length > 0) return queueLabels;
  }
  return [];
}

function retryQueueSnapshotForCloseout(
  closeoutIssue,
  initialIssue,
  listedIssue,
) {
  const closeoutQueueLabels = queueLabelsFromIssue(closeoutIssue);
  if (closeoutQueueLabels.length > 0) {
    return { labels: closeoutQueueLabels, compensateAfterAdd: true };
  }

  // Stale queue evidence needs a visible state that cannot grant review or
  // release authority if the issue reopens during recovery.
  return {
    labels:
      nearestQueueLabels(initialIssue, listedIssue).length > 0
        ? labelsForState("grooming").addLabels
        : [],
    compensateAfterAdd: false,
  };
}

function hasExactQueueLabels(issue, state) {
  const expected = labelsForState(state).addLabels;
  const actual = queueLabelsFromIssue(issue);
  return (
    actual.length === expected.length &&
    expected.every((label) => actual.includes(label))
  );
}

function conflictingOpenQueueLabels(issue) {
  if (String(issue.state ?? "").toUpperCase() !== "OPEN") return [];
  const labels = queueLabelsFromIssue(issue);
  return labels.length > 1 ? labels : [];
}

function stateForQueueLabel(issue, label) {
  return stateFromLabels({
    ...issue,
    state: "OPEN",
    labels: [{ name: label }],
  });
}

function restoreStateFromCloseoutIssue(issue) {
  const queueLabels = queueLabelsFromIssue(issue);
  if (queueLabels.length !== 1) return null;
  return stateForQueueLabel(issue, queueLabels[0]);
}

async function restoreProvisionalQueueLabel(
  options,
  issue,
  provisionalQueueLabel,
  operations,
) {
  const provisionalState = stateForQueueLabel(issue, provisionalQueueLabel);
  if (!provisionalState) return issue;

  await operations.editIssueLabels(options, issue, provisionalState);
  return operations.getIssue(options, issue.number);
}

async function compensateProvisionalQueueLabel(
  options,
  issue,
  provisionalQueueLabel,
  operations,
) {
  let currentIssue = issue;
  for (let attempt = 1; attempt <= SYNC_COMPENSATE_ATTEMPTS; attempt += 1) {
    if (!provisionalQueueLabel) {
      return { issue: currentIssue, provisionalQueueLabel };
    }
    if (String(currentIssue.state ?? "").toUpperCase() !== "OPEN") {
      return { issue: currentIssue, provisionalQueueLabel: null };
    }

    const queueLabels = queueLabelsFromIssue(currentIssue);
    if (!queueLabels.includes(provisionalQueueLabel)) {
      if (queueLabels.length === 0) {
        currentIssue = await restoreProvisionalQueueLabel(
          options,
          currentIssue,
          provisionalQueueLabel,
          operations,
        );
        continue;
      }
      return { issue: currentIssue, provisionalQueueLabel: null };
    }
    if (queueLabels.length !== 2) {
      return { issue: currentIssue, provisionalQueueLabel };
    }

    const concurrentLabel = queueLabels.find(
      (label) => label !== provisionalQueueLabel,
    );
    const concurrentState = stateForQueueLabel(currentIssue, concurrentLabel);
    if (!concurrentState) {
      return { issue: currentIssue, provisionalQueueLabel };
    }

    await operations.editIssueLabels(options, currentIssue, concurrentState);
    currentIssue = await operations.getIssue(options, currentIssue.number);
  }

  return { issue: currentIssue, provisionalQueueLabel };
}

async function reconcileRetryQueueObservation(
  options,
  issue,
  retryQueueLabels,
  operations,
) {
  let verified = issue;
  if (
    retryQueueLabels.length === 1 &&
    queueLabelsFromIssue(verified).length > 0
  ) {
    ({ issue: verified } = await compensateProvisionalQueueLabel(
      options,
      verified,
      retryQueueLabels[0],
      operations,
    ));
  }
  return verified;
}

async function preserveRetryQueueLabels(
  options,
  issue,
  retryQueueLabels,
  compensateAfterAdd,
  operations,
) {
  if (retryQueueLabels.length === 0) {
    throw new Error(`Issue #${issue.number} has no queue label to restore`);
  }

  let lastError = null;
  let addAttempted = false;
  for (let attempt = 1; attempt <= SYNC_VERIFY_ATTEMPTS; attempt += 1) {
    let verified;
    try {
      verified = await operations.getIssue(options, issue.number);
      if (addAttempted && compensateAfterAdd) {
        verified = await reconcileRetryQueueObservation(
          options,
          verified,
          retryQueueLabels,
          operations,
        );
      }
      if (queueLabelsFromIssue(verified).length > 0) return verified;
    } catch (error) {
      lastError = error;
      if (attempt < SYNC_VERIFY_ATTEMPTS) {
        await operations.sleep(SYNC_VERIFY_SETTLE_MS);
      }
      continue;
    }

    let addError = null;
    addAttempted = true;
    try {
      await operations.addIssueLabels(options, verified, retryQueueLabels);
    } catch (error) {
      addError = error;
    }

    try {
      verified = await operations.getIssue(options, issue.number);
      if (compensateAfterAdd) {
        verified = await reconcileRetryQueueObservation(
          options,
          verified,
          retryQueueLabels,
          operations,
        );
      }
      if (queueLabelsFromIssue(verified).length > 0) return verified;
      lastError =
        addError ??
        new Error(
          `Issue #${issue.number} still has no queue label after restoration attempt ${attempt}`,
        );
    } catch (error) {
      lastError = error;
    }
    if (attempt < SYNC_VERIFY_ATTEMPTS) {
      await operations.sleep(SYNC_VERIFY_SETTLE_MS);
    }
  }
  throw new Error(
    `Issue #${issue.number} has no queue label after ${SYNC_VERIFY_ATTEMPTS} retry-label restoration attempts`,
    { cause: lastError },
  );
}

export class IssueBoardSyncError extends AggregateError {
  constructor(results, failures) {
    const normalizedFailures = failures.map(({ number, title, error }) => ({
      number,
      title,
      message: error instanceof Error ? error.message : String(error),
    }));
    const succeeded = results.map((result) => `#${result.number}`).join(", ");
    const failed = normalizedFailures
      .map((failure) => `#${failure.number}: ${failure.message}`)
      .join("; ");
    super(
      failures.map((failure) => failure.error),
      [
        `Issue-board sync completed with ${normalizedFailures.length} failure(s) after ${results.length} success(es).`,
        `Succeeded: ${succeeded || "none"}.`,
        `Failed: ${failed}.`,
      ].join("\n"),
    );
    this.name = "IssueBoardSyncError";
    this.results = results;
    this.failures = normalizedFailures;
  }
}

async function syncIssue(options, project, listedIssue, operations) {
  let issue = await operations.getIssue(options, listedIssue.number);
  const initialIssue = issue;
  let drift = null;
  let provisionalQueueLabel = null;

  for (let attempt = 1; attempt <= SYNC_RECONCILE_ATTEMPTS; attempt += 1) {
    ({ issue, provisionalQueueLabel } = await compensateProvisionalQueueLabel(
      options,
      issue,
      provisionalQueueLabel,
      operations,
    ));
    const conflictingLabels = conflictingOpenQueueLabels(issue);
    if (conflictingLabels.length > 0) {
      drift = `conflicting queue labels (${conflictingLabels.join(", ")})`;
      if (attempt < SYNC_RECONCILE_ATTEMPTS) {
        await operations.sleep(SYNC_VERIFY_SETTLE_MS);
        issue = await operations.getIssue(options, issue.number);
        continue;
      }
      throw new Error(
        `Issue #${issue.number} retained conflicting queue labels after ${SYNC_RECONCILE_ATTEMPTS} attempts: ${conflictingLabels.join(", ")}`,
      );
    }

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
      if (options.dryRun) {
        await operations.editIssueLabels(options, issue, state);
        return { number: issue.number, title: issue.title, state };
      }

      const closeoutIssue = await operations.getIssue(options, issue.number);
      const closeoutState = syncStateFromIssue(closeoutIssue);
      if (closeoutState !== "done") {
        drift = `done -> ${closeoutState ?? "no queue state"}`;
        if (attempt < SYNC_RECONCILE_ATTEMPTS) {
          issue = closeoutIssue;
          await operations.sleep(SYNC_VERIFY_SETTLE_MS);
          continue;
        }
        break;
      }

      const closeoutItemId = await operations.findIssueProjectItem(
        options,
        closeoutIssue,
        project,
      );
      if (closeoutItemId) {
        await operations.updateProjectFields(
          options,
          project,
          closeoutItemId,
          state,
          {},
        );
      }

      const reopenState = restoreStateFromCloseoutIssue(closeoutIssue);
      const retryQueueSnapshot = retryQueueSnapshotForCloseout(
        closeoutIssue,
        initialIssue,
        listedIssue,
      );
      await operations.editIssueLabels(options, closeoutIssue, state);
      let verifiedIssue = await verifySyncCloseout(
        options,
        closeoutIssue,
        operations,
      );
      if (String(verifiedIssue.state ?? "").toUpperCase() === "CLOSED") {
        const verifiedItemId = await operations.findIssueProjectItem(
          options,
          verifiedIssue,
          project,
        );
        if (!verifiedItemId) {
          return { number: issue.number, title: issue.title, state };
        }
        try {
          await operations.updateProjectFields(
            options,
            project,
            verifiedItemId,
            state,
            {},
          );
        } catch (projectionError) {
          try {
            await preserveRetryQueueLabels(
              options,
              verifiedIssue,
              retryQueueSnapshot.labels,
              retryQueueSnapshot.compensateAfterAdd,
              operations,
            );
          } catch (retryError) {
            throw new AggregateError(
              [projectionError, retryError],
              `Issue #${issue.number} late Done projection and retry-label restoration failed`,
              { cause: retryError },
            );
          }
          throw projectionError;
        }
        verifiedIssue = await verifySyncCloseout(
          options,
          verifiedIssue,
          operations,
        );
        if (String(verifiedIssue.state ?? "").toUpperCase() === "CLOSED") {
          return { number: issue.number, title: issue.title, state };
        }
      }

      let reopenedIssue = verifiedIssue;
      let reopenedState = syncStateFromIssue(reopenedIssue);
      if (!reopenedState && reopenState) {
        reopenedIssue = await operations.getIssue(options, issue.number);
        reopenedState = syncStateFromIssue(reopenedIssue);
        if (!reopenedState) {
          await operations.editIssueLabels(options, reopenedIssue, reopenState);
          [provisionalQueueLabel] = labelsForState(reopenState).addLabels;
          reopenedIssue = await operations.getIssue(options, issue.number);
          ({ issue: reopenedIssue, provisionalQueueLabel } =
            await compensateProvisionalQueueLabel(
              options,
              reopenedIssue,
              provisionalQueueLabel,
              operations,
            ));
          reopenedState = syncStateFromIssue(reopenedIssue);
        }
      }
      drift =
        reopenedState &&
        reopenedState !== "done" &&
        !hasExactQueueLabels(reopenedIssue, reopenedState)
          ? `done -> conflicting queue labels (${queueLabelsFromIssue(reopenedIssue).join(", ")})`
          : `done -> ${reopenedState ?? "no queue state"}`;
      if (attempt < SYNC_RECONCILE_ATTEMPTS) {
        issue = reopenedIssue;
        await operations.sleep(SYNC_VERIFY_SETTLE_MS);
        continue;
      }
      break;
    }

    const itemId = await operations.ensureProjectItem(options, project, issue);
    if (!itemId) return null;
    await operations.updateProjectFields(options, project, itemId, state, {});
    if (options.dryRun) {
      return { number: issue.number, title: issue.title, state };
    }

    let verified = await operations.getIssue(options, issue.number);
    ({ issue: verified, provisionalQueueLabel } =
      await compensateProvisionalQueueLabel(
        options,
        verified,
        provisionalQueueLabel,
        operations,
      ));
    const verifiedState = syncStateFromIssue(verified);
    if (verifiedState === state && hasExactQueueLabels(verified, state)) {
      return { number: issue.number, title: issue.title, state };
    }

    drift =
      verifiedState === state
        ? `${state} -> conflicting queue labels (${queueLabelsFromIssue(verified).join(", ")})`
        : `${state} -> ${verifiedState ?? "no queue state"}`;
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
    addIssueLabels,
    editIssueLabels,
    ensureProjectItem,
    findIssueProjectItem,
    getIssue,
    getProject,
    listIssuesByLabels,
    sleep,
    updateProjectFields,
    ...dependencies,
  };
  const project = await operations.getProject(options);
  const byNumber = new Map();
  for (const issue of await operations.listIssuesByLabels(
    options,
    ISSUE_STATE_LABELS,
    { state: "all" },
  )) {
    byNumber.set(issue.number, issue);
  }

  const results = [];
  const failures = [];
  for (const listedIssue of byNumber.values()) {
    try {
      const result = await syncIssue(options, project, listedIssue, operations);
      if (result) results.push(result);
    } catch (error) {
      failures.push({
        number: listedIssue.number,
        title: listedIssue.title,
        error,
      });
    }
  }
  if (failures.length > 0) throw new IssueBoardSyncError(results, failures);
  return results;
}
