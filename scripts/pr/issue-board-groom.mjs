/**
 * Grooming routing-label writes, serialized behind the per-issue mutex.
 *
 * The backlog-sweep grooming pass writes `pkg:*`, `risk:*`, and `kind:*` labels
 * on issues it did not claim. Its no-widening rule is computed from a roster
 * snapshot, so a state label landing between that check and a raw
 * `gh issue edit` can make the routing write the action that completes sweep
 * eligibility. This command closes that window: it takes the
 * [ADR 0082](../../docs/adr/0082-persistent-issue-board-mutation-mutex.md)
 * per-issue mutex, re-reads the live labels inside the serialized section, and
 * refuses when the set the write would produce satisfies the sweep predicate.
 *
 * The mutex serializes helpers, not humans. A person can still add
 * `agent-ready` through the GitHub UI while this command holds the lock, so the
 * write is re-read afterwards. When this write completed eligibility, exactly
 * the labels it added are removed again. When the issue satisfies the predicate
 * without them, this write was not the cause: the labels stay and the command
 * reports the concurrent write rather than undoing a correct label and
 * declaring the issue safe.
 *
 * It never writes a state label and never writes a Project field. `issue:claim`,
 * `issue:review`, and `issue:release` own queue state and ownership. The
 * mutex makes a claim landing between the sweep's roster snapshot and this
 * call observable too: the in-mutex read refuses an issue already carrying
 * `agent-active` or `in-pr`, the same "never touch an owned issue" rule the
 * pass follows everywhere else.
 */

import {
  ISSUE_STATE_LABELS,
  isSafeSingleLineText,
  labelNames,
  satisfiesSweepLabelEligibility,
  stateFromLabels,
} from "./issue-board-state.mjs";
import { getProject } from "./issue-board-projects.mjs";
import { withIssueMutationLock } from "./issue-board-lock.mjs";
import {
  addIssueLabels,
  getIssue,
  removeIssueLabels,
} from "./issue-board-transport.mjs";

export const GROOM_ROUTING_LABEL_PREFIXES = Object.freeze([
  "pkg:",
  "risk:",
  "kind:",
]);
const MAX_GROOM_LABEL_LENGTH = 120;

/** A requested label the command will not write at all. */
export const GROOM_LABEL_REFUSED_EXIT_CODE = 3;
/** The write would leave the issue sweep-eligible. Nothing was written. */
export const GROOM_ELIGIBILITY_REFUSED_EXIT_CODE = 4;
/** The write landed, completed eligibility, and was undone. */
export const GROOM_COMPENSATED_EXIT_CODE = 5;
/** The write landed, completed eligibility, and could not be undone. */
export const GROOM_COMPENSATION_FAILED_EXIT_CODE = 6;
/** A concurrent write left the issue eligible; this call did not cause it. */
export const GROOM_CONCURRENT_ELIGIBILITY_EXIT_CODE = 7;

export class IssueGroomLabelRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomLabelRefusedError";
    this.code = "ISSUE_GROOM_LABEL_REFUSED";
    this.exitCode = GROOM_LABEL_REFUSED_EXIT_CODE;
    this.details = details;
  }
}

export class IssueGroomEligibilityRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomEligibilityRefusedError";
    this.code = "ISSUE_GROOM_ELIGIBILITY_REFUSED";
    this.exitCode = GROOM_ELIGIBILITY_REFUSED_EXIT_CODE;
    this.details = details;
  }
}

export class IssueGroomCompensatedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomCompensatedError";
    this.code = "ISSUE_GROOM_COMPENSATED";
    this.exitCode = GROOM_COMPENSATED_EXIT_CODE;
    this.details = details;
  }
}

export class IssueGroomCompensationFailedError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "IssueGroomCompensationFailedError";
    this.code = "ISSUE_GROOM_COMPENSATION_FAILED";
    this.exitCode = GROOM_COMPENSATION_FAILED_EXIT_CODE;
    this.details = details;
  }
}

export class IssueGroomConcurrentEligibilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomConcurrentEligibilityError";
    this.code = "ISSUE_GROOM_CONCURRENT_ELIGIBILITY";
    this.exitCode = GROOM_CONCURRENT_ELIGIBILITY_EXIT_CODE;
    this.details = details;
  }
}

/**
 * The process exit code an issue-board failure asks for, or 1.
 *
 * Refusals are wrapped: a compensation failure keeps the mutex, so the lock
 * layer rethrows it inside `IssueMutationLockStaleError`. Walk the cause chain
 * so the caller still sees which refusal happened.
 *
 * The walk stops at `cause` and never enters `AggregateError.errors`, on the
 * same rule ADR 0082 states for the stale-lock code. A refusal whose mutex
 * release then failed is wrapped in an `AggregateError` holding the refusal
 * beside the release failure, and every refusal code above promises what the
 * mutex did. Reading the refusal out of that wrapper would report exit 5 —
 * compensated, mutex released — for a run that left the mutex held. Such a run
 * exits 1, and the runbook's exit table routes any other nonzero exit to the
 * operator.
 */
export function issueBoardExitCode(err) {
  const seen = new Set();
  let current = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (Number.isInteger(current.exitCode) && current.exitCode > 0) {
      return current.exitCode;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return 1;
}

/**
 * The routing labels to request, or a refusal naming the first bad one.
 *
 * State labels are refused by name and by rule: only the three routing
 * prefixes are writable here, so a label class added later is refused until
 * someone decides it belongs.
 */
export function validateGroomLabels(labels) {
  const requested = [...new Set(labels ?? [])];
  if (requested.length === 0) {
    throw new Error("groom requires at least one --add-label routing label");
  }
  for (const label of requested) {
    if (!isSafeSingleLineText(label, MAX_GROOM_LABEL_LENGTH)) {
      throw new Error(
        `groom label must be 1-${MAX_GROOM_LABEL_LENGTH} single-line characters with no leading or trailing whitespace: ${JSON.stringify(label)}`,
      );
    }
    if (label.includes(",")) {
      throw new IssueGroomLabelRefusedError(
        `groom refuses ${JSON.stringify(label)}: gh issue edit takes one comma-separated list, so a comma inside a label writes two labels and carries the second past every check below`,
        { label, requested },
      );
    }
    if (ISSUE_STATE_LABELS.includes(label)) {
      throw new IssueGroomLabelRefusedError(
        `groom refuses the queue-state label ${label}; ADR 0082 gives state writes to issue:claim, issue:review, and issue:release`,
        { label, requested },
      );
    }
    if (
      !GROOM_ROUTING_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
    ) {
      throw new IssueGroomLabelRefusedError(
        `groom writes only ${GROOM_ROUTING_LABEL_PREFIXES.join(", ")} routing labels; refusing ${label}`,
        { label, requested },
      );
    }
  }
  return requested;
}

function eligibilityText(labels) {
  return [...labels].sort().join(", ");
}

/**
 * Undoes exactly the labels `groomLocked` added, once their presence is known
 * to have completed sweep eligibility.
 *
 * `additions` is attributed by absence, not by proof: a label this call is
 * about to add and a label a human adds through the GitHub UI in the same
 * instant are indistinguishable once both land, because the labels API has no
 * compare-and-swap and its response never says which caller added a label.
 * For every other label this call adds, that is not a real gap — nothing else
 * is independently trying to add that exact string, so absence-before and
 * presence-after is sufficient proof. Only a human racing this call onto the
 * identical routing label is genuinely ambiguous, and there is no cheaper way
 * to resolve it than a timeline read that is itself racy against the same
 * window. Removing it anyway keeps this call's own promise — that its write
 * never completes sweep eligibility — the same way exit 7 already keeps that
 * promise for a *different* concurrent label; the cost is a label a human may
 * have to add back, not a state transition or a lost queue position. Treating
 * that as a reason to retain LOCK instead would turn every exit 5 into an
 * exit 6, discarding the automatic compensation this module tests and ADR
 * 0082 documents as the answer to a human racing the helper.
 */
async function compensate(options, issue, additions, dependencies) {
  await dependencies.removeIssueLabels(options, issue, additions);
  const compensated = await dependencies.getIssue(options, issue.number);
  const retained = additions.filter((label) =>
    labelNames(compensated).has(label),
  );
  if (retained.length > 0) {
    const error = new Error(
      `the removal call returned success but ${retained.join(", ")} is still on the issue`,
    );
    error.retainedLabels = retained;
    throw error;
  }
  if (satisfiesSweepLabelEligibility(labelNames(compensated))) {
    const error = new Error(
      `the removal call returned success but ${eligibilityText(labelNames(compensated))} still satisfies the sweep predicate`,
    );
    error.retainedLabels = [];
    error.currentLabels = [...labelNames(compensated)];
    throw error;
  }
  return compensated;
}

/**
 * The grooming write itself, already inside the serialized section.
 *
 * Every path before `addIssueLabels` releases the mutex on the way out, the way
 * claim, review, release, sync, and backfill do: a transient `gh issue view`
 * failure must not strand a per-issue LOCK that only manual ref surgery clears.
 * From the write onward the outcome is ambiguous, so the mutex is released only
 * where this function proves what the board holds.
 */
async function groomLocked(options, number, labels, dependencies, lease) {
  let mutationAttempted = false;
  try {
    const issue = await dependencies.getIssue(options, number);
    if (String(issue.state ?? "").toUpperCase() !== "OPEN") {
      throw new Error(`Issue #${number} is not open; groom writes open issues`);
    }

    // A claim can win the mutex between the sweep's roster snapshot and this
    // call: the pass never touches an owned issue, and the in-mutex read is
    // the first point this command can see that ownership landed.
    const owningState = stateFromLabels(issue);
    if (owningState === "active" || owningState === "review") {
      throw new Error(
        `Issue #${number} is owned (state: ${owningState}); groom does not write routing labels on an owned issue`,
      );
    }

    const current = labelNames(issue);
    const additions = labels.filter((label) => !current.has(label));
    if (additions.length === 0) {
      return {
        number: issue.number,
        title: issue.title,
        state: "groomed",
        writes: [],
      };
    }

    const postWrite = new Set([...current, ...additions]);
    if (satisfiesSweepLabelEligibility(postWrite)) {
      throw new IssueGroomEligibilityRefusedError(
        `Issue #${number} groom refused: adding ${additions.join(", ")} would leave ${eligibilityText(postWrite)}, which satisfies the sweep predicate (agent-ready, exactly one risk:* equal to risk:low, exactly one pkg:*). Propose the label for a human instead of writing it.`,
        {
          issue: number,
          requested: labels,
          additions,
          postWrite: [...postWrite],
        },
      );
    }

    mutationAttempted = true;
    await dependencies.addIssueLabels(options, issue, additions);

    const after = await dependencies.getIssue(options, number);
    const afterNames = labelNames(after);

    // A concurrent actor — a human, or the file-size watchlist job — can
    // remove one of this call's own additions in the window between the write
    // and this read. Every branch below assumes `additions` landed; verify it
    // before trusting any of them, success included.
    const missing = additions.filter((label) => !afterNames.has(label));
    if (missing.length > 0) {
      throw new Error(
        `Issue #${number} groom wrote ${additions.join(", ")}, but ${missing.join(", ")} is not on the issue after the write. The outcome is ambiguous; an operator must check the issue before it is treated as groomed.`,
      );
    }

    if (!satisfiesSweepLabelEligibility(afterNames)) {
      return {
        number: after.number,
        title: after.title,
        state: "groomed",
        writes: additions.map((label) => ({ field: "label", value: label })),
      };
    }

    // Compensate only what this call caused. The predicate reads `agent-ready`,
    // `risk:*`, and `pkg:*`, so a `kind:*` write can never complete it: undoing
    // that write would destroy a correct label and still leave the issue
    // eligible, while reporting the opposite.
    const withoutAdditions = new Set(
      [...afterNames].filter((label) => !additions.includes(label)),
    );
    if (satisfiesSweepLabelEligibility(withoutAdditions)) {
      lease.markSafeToUnlock("groom write did not cause eligibility");
      throw new IssueGroomConcurrentEligibilityError(
        `Issue #${number} groom wrote ${additions.join(", ")} and a label landed after the in-mutex read, leaving ${eligibilityText(afterNames)}, which satisfies the sweep predicate. This call did not cause it: ${eligibilityText(withoutAdditions)} satisfies the predicate without the labels this call added, so those labels were kept. A human must look at the issue before a sweep selects it.`,
        { issue: number, additions, labels: [...afterNames] },
      );
    }

    let compensated;
    try {
      compensated = await compensate(options, after, additions, dependencies);
    } catch (compensationError) {
      const reason =
        compensationError instanceof Error
          ? compensationError.message
          : String(compensationError);
      // The two ways compensate() fails need different recovery text: when the
      // removal itself did not land, additions are the labels to remove by
      // hand; when the removal succeeded and a *different* label still
      // satisfies the predicate, additions are already gone and telling the
      // operator to remove them again is wrong — point at the current set
      // `reason` already names instead.
      const retainedLabels = Array.isArray(compensationError?.retainedLabels)
        ? compensationError.retainedLabels
        : additions;
      const recovery =
        retainedLabels.length > 0
          ? `Remove ${retainedLabels.join(", ")} by hand before releasing the mutex.`
          : `${additions.join(", ")} is already off the issue; an operator must find and clear whatever else in the current label set still satisfies the predicate before releasing the mutex.`;
      throw new IssueGroomCompensationFailedError(
        `Issue #${number} groom wrote ${additions.join(", ")}, a label landed after the in-mutex read, and the issue is now sweep-eligible. Compensation failed: ${reason}. ${recovery}`,
        { issue: number, additions },
        { cause: compensationError },
      );
    }
    lease.markSafeToUnlock("groom compensated: added labels removed");
    throw new IssueGroomCompensatedError(
      `Issue #${number} groom wrote ${additions.join(", ")}, a label landed after the in-mutex read, and the write completed sweep eligibility. Compensated by removing ${additions.join(", ")}; the issue is back to ${eligibilityText(labelNames(compensated))}, which no longer satisfies the sweep predicate. Propose the label for a human instead.`,
      { issue: number, additions, compensated: additions },
    );
  } catch (err) {
    if (!mutationAttempted) {
      lease.markSafeToUnlock("groom rejected before mutation");
    }
    throw err;
  }
}

/**
 * Apply grooming routing labels to one issue under the per-issue mutex.
 *
 * Returns the one-element result list `renderResults` prints. Every refusal
 * throws with an `exitCode`; read it through `issueBoardExitCode`.
 */
export async function groom(options, overrides = {}) {
  if (options.issues.length !== 1) {
    throw new Error("groom requires exactly one explicit --issue");
  }
  const labels = validateGroomLabels(options.addLabels);
  const dependencies = {
    addIssueLabels,
    getIssue,
    getProject,
    removeIssueLabels,
    withIssueMutationLock,
    ...overrides,
  };
  const number = options.issues[0];
  const project = await dependencies.getProject(options);
  return [
    await dependencies.withIssueMutationLock(
      options,
      number,
      { operation: "groom", projectId: project.id, agent: options.agent },
      (lease) => groomLocked(options, number, labels, dependencies, lease),
    ),
  ];
}
