/**
 * Issue-board reconciliation and closeout.
 *
 * Queue labels remain authoritative. This layer keeps open queue items in the
 * selected Project, removes stale queue labels from closed issues, and verifies
 * concurrent close, reopen, and label changes. It never writes the human-owned
 * Project Status field.
 */

import {
  incompleteGroomingFinding,
  ISSUE_STATE_LABELS,
  labelNames,
  labelsForState,
  stateFromLabels,
} from "./issue-board-state.mjs";
import {
  ensureProjectItem,
  findIssueProjectItem,
  getProject,
} from "./issue-board-projects.mjs";
import {
  addIssueLabels,
  editIssueLabels,
  getIssue,
  listIssuesByLabels,
  sleep,
} from "./issue-board-transport.mjs";
import { withIssueMutationLock } from "./issue-board-lock.mjs";
import {
  readClaimOwnership,
  readIssueLockOwnership,
  preflightStableSyncIssue,
  runLockedSyncIssue,
} from "./issue-board-sync-lock.mjs";

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
  if (closeoutQueueLabels.length === 1) {
    return { labels: closeoutQueueLabels, compensateAfterAdd: true };
  }

  // Ambiguous or stale queue evidence needs a visible state that cannot grant
  // claim, review, or release authority if the issue reopens during recovery.
  const hasRetryEvidence =
    closeoutQueueLabels.length > 1 ||
    nearestQueueLabels(initialIssue, listedIssue).length > 0;
  return {
    labels: hasRetryEvidence ? labelsForState("grooming").addLabels : [],
    // GitHub label additions are idempotent. A successful quarantine add does
    // not prove that this recovery created the label. Preserve any conflict so
    // a stale fallback cannot grant claim, review, or release authority.
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
  let provisionalAddConfirmed = false;
  for (let attempt = 1; attempt <= SYNC_VERIFY_ATTEMPTS; attempt += 1) {
    let verified;
    try {
      verified = await operations.getIssue(options, issue.number);
      if (provisionalAddConfirmed && compensateAfterAdd) {
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
    try {
      await operations.addIssueLabels(options, verified, retryQueueLabels);
      provisionalAddConfirmed = true;
    } catch (error) {
      addError = error;
    }

    try {
      verified = await operations.getIssue(options, issue.number);
      if (provisionalAddConfirmed && compensateAfterAdd) {
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
        `Issue #${issue.number} lost its queue state during sync after ${attempt} attempt(s); last queue drift was ${drift}`,
      );
    }

    if (state === "done") {
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

      const retryQueueSnapshot = retryQueueSnapshotForCloseout(
        closeoutIssue,
        initialIssue,
        listedIssue,
      );
      const reopenState =
        restoreStateFromCloseoutIssue(closeoutIssue) ??
        (retryQueueSnapshot.labels.length > 0 ? "grooming" : null);
      let verifiedIssue;
      try {
        await operations.editIssueLabels(options, closeoutIssue, state);
        verifiedIssue = await verifySyncCloseout(
          options,
          closeoutIssue,
          operations,
        );
        if (String(verifiedIssue.state ?? "").toUpperCase() === "CLOSED") {
          return { number: issue.number, title: issue.title, state };
        }

        let reopenedIssue = verifiedIssue;
        let reopenedState = syncStateFromIssue(reopenedIssue);
        if (!reopenedState && reopenState) {
          reopenedIssue = await operations.getIssue(options, issue.number);
          reopenedState = syncStateFromIssue(reopenedIssue);
          if (!reopenedState) {
            await operations.editIssueLabels(
              options,
              reopenedIssue,
              reopenState,
            );
            provisionalQueueLabel = retryQueueSnapshot.compensateAfterAdd
              ? labelsForState(reopenState).addLabels[0]
              : null;
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
      } catch (postCleanupError) {
        try {
          await preserveRetryQueueLabels(
            options,
            verifiedIssue ?? closeoutIssue,
            retryQueueSnapshot.labels,
            retryQueueSnapshot.compensateAfterAdd,
            operations,
          );
        } catch (retryError) {
          throw new AggregateError(
            [postCleanupError, retryError],
            `Issue #${issue.number} post-cleanup sync and retry-label restoration failed`,
            { cause: retryError },
          );
        }
        throw postCleanupError;
      }
    }

    const itemId = await operations.ensureProjectItem(options, project, issue);
    if (!itemId) {
      throw new Error(
        `Issue #${issue.number} Project membership mutation did not return the selected item ID`,
      );
    }
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
    `Issue #${issue.number} did not stabilize during sync after ${SYNC_RECONCILE_ATTEMPTS} attempts; last queue drift was ${drift}`,
  );
}

async function syncListedIssue(options, project, listedIssue, operations) {
  const stable = await operations.preflightStableSyncIssue(
    options,
    project,
    listedIssue,
    operations,
  );
  if (stable) return stable;
  return runLockedSyncIssue(
    options,
    project,
    listedIssue,
    operations,
    syncIssue,
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
    preflightStableSyncIssue,
    readClaimOwnership,
    readIssueLockOwnership,
    sleep,
    withIssueMutationLock,
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
    let synced = true;
    try {
      const result = await syncListedIssue(
        options,
        project,
        listedIssue,
        operations,
      );
      if (result) results.push(result);
    } catch (error) {
      synced = false;
      failures.push({
        number: listedIssue.number,
        title: listedIssue.title,
        error,
      });
    }
    // Label hygiene rides the same repo-wide enumeration. It runs after the
    // projection, so a thinly labeled issue still reaches the Project, and a
    // per-issue sync failure leaves its grooming gap to the next run.
    if (!synced) continue;
    // The enumeration snapshot is stale by now: this issue may have been
    // claimed or relabelled while its own sync ran. Use the snapshot only to
    // decide whether a read is worth spending, then report solely on what that
    // read proves. An issue promoted into a bare `agent-ready` mid-run is
    // reported by the next run rather than guessed at here.
    if (!incompleteGroomingFinding(listedIssue)) continue;
    try {
      const finding = incompleteGroomingFinding(
        await operations.getIssue(options, listedIssue.number),
      );
      if (finding) {
        failures.push({
          number: listedIssue.number,
          title: listedIssue.title,
          error: new Error(finding),
        });
      }
    } catch (error) {
      failures.push({
        number: listedIssue.number,
        title: listedIssue.title,
        error: new Error(
          `Issue #${listedIssue.number} looked incompletely groomed, but its confirming read failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      });
    }
  }
  if (failures.length > 0) throw new IssueBoardSyncError(results, failures);
  return results;
}
