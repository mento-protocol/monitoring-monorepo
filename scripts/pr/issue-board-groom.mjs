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
 * pass follows everywhere else. One refusal comes before the mutex: a label
 * the repository does not define makes `gh issue edit` fail only after the
 * write is attempted, so that label is refused before the lock is taken.
 */

import {
  ISSUE_OWNED_STATE_LABELS,
  ISSUE_STATE_LABELS,
  isSafeSingleLineText,
  labelNames,
  satisfiesSweepLabelEligibility,
} from "./issue-board-state.mjs";
import { getProject } from "./issue-board-projects.mjs";
import { withIssueMutationLock } from "./issue-board-lock.mjs";
import {
  addIssueLabels,
  getIssue,
  listRepoLabelNames,
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
/** A live claim owns the issue. Nothing was written. */
export const GROOM_OWNED_REFUSED_EXIT_CODE = 8;
/** The post-write read does not show this call's labels. The mutex is held. */
export const GROOM_WRITE_UNCONFIRMED_EXIT_CODE = 9;

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

export class IssueGroomOwnedRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomOwnedRefusedError";
    this.code = "ISSUE_GROOM_OWNED_REFUSED";
    this.exitCode = GROOM_OWNED_REFUSED_EXIT_CODE;
    this.details = details;
  }
}

export class IssueGroomWriteUnconfirmedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IssueGroomWriteUnconfirmedError";
    this.code = "ISSUE_GROOM_WRITE_UNCONFIRMED";
    this.exitCode = GROOM_WRITE_UNCONFIRMED_EXIT_CODE;
    this.details = details;
  }
}

/**
 * A compensation attempt that did not prove the board is safe.
 *
 * `retainedLabels` is what the removal left behind. It tells a removal that
 * did not land, where this call's labels are the ones to remove by hand, from
 * a removal that succeeded while a different label keeps the issue eligible,
 * where naming those labels again sends the operator after labels that are
 * already gone.
 */
class GroomCompensationError extends Error {
  constructor(message, { retainedLabels = [], currentLabels = [] } = {}) {
    super(message);
    this.name = "GroomCompensationError";
    this.retainedLabels = retainedLabels;
    this.currentLabels = currentLabels;
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
    throw new GroomCompensationError(
      `the removal call returned success but ${retained.join(", ")} is still on the issue`,
      {
        retainedLabels: retained,
        currentLabels: [...labelNames(compensated)],
      },
    );
  }
  if (satisfiesSweepLabelEligibility(labelNames(compensated))) {
    throw new GroomCompensationError(
      `the removal call returned success but ${eligibilityText(labelNames(compensated))} still satisfies the sweep predicate`,
      { currentLabels: [...labelNames(compensated)] },
    );
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

    const current = labelNames(issue);

    // A claim can win the mutex between the sweep's roster snapshot and this
    // call: the pass never touches an owned issue, and the in-mutex read is
    // the first point this command can see that ownership landed. Refuse
    // before computing additions, so nothing is written and the mutex goes
    // back to the session that owns the issue.
    const owned = ISSUE_OWNED_STATE_LABELS.filter((label) =>
      current.has(label),
    );
    if (owned.length > 0) {
      throw new IssueGroomOwnedRefusedError(
        `Issue #${number} groom refused: ${owned.join(", ")} means a live claim owns the issue, and the routing verdict this call carries was read before that claim landed. Nothing was written. Groom it again after the claim releases the issue.`,
        { issue: number, requested: labels, owned },
      );
    }

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

    // A dry run prints the `gh` command and writes nothing, so every check
    // below would read this call's own labels as missing and refuse. Report
    // the write it would make, the way the other board commands report a dry
    // run, and leave the proofs to the run that writes.
    if (options.dryRun) {
      return {
        number: issue.number,
        title: issue.title,
        state: "groomed",
        writes: additions.map((label) => ({ field: "label", value: label })),
      };
    }

    const after = await dependencies.getIssue(options, number);
    const afterNames = labelNames(after);

    // A concurrent actor — a human, or the file-size watchlist job — can
    // remove one of this call's own additions in the window between the write
    // and this read, and a read that lags the write looks the same from here.
    // Both leave the write unproven, and the lagging read cannot rule out that
    // this write left the issue sweep-eligible. Every branch below reasons
    // from `additions` having landed, so refuse before all of them and keep
    // the mutex: only a person reading the issue can say what the board holds.
    const unconfirmed = additions.filter((label) => !afterNames.has(label));
    if (unconfirmed.length > 0) {
      throw new IssueGroomWriteUnconfirmedError(
        `Issue #${number} groom wrote ${additions.join(", ")}, and the confirming read does not show ${unconfirmed.join(", ")}: it read ${eligibilityText(afterNames)}. Either the label was removed after the write or the read lagged it, so this call cannot prove its write left the issue sweep-ineligible. The mutex is held: read the issue's labels, remove ${additions.join(", ")} if the issue is sweep-eligible, then clear the mutex.`,
        { issue: number, additions, unconfirmed, labels: [...afterNames] },
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
      // removal itself did not land, the labels it left behind are the ones to
      // remove by hand; when the removal succeeded and a *different* label
      // still satisfies the predicate, this call's labels are already gone, so
      // the text names the set that satisfies the predicate now instead of
      // sending the operator after labels nothing can find.
      const outcome =
        compensationError instanceof GroomCompensationError
          ? compensationError
          : null;
      let recovery;
      if (outcome && outcome.retainedLabels.length === 0) {
        recovery = `${additions.join(", ")} is already off the issue, so removing it again cannot clear eligibility: ${eligibilityText(outcome.currentLabels)} is what satisfies the sweep predicate now. Decide which of those labels is wrong, clear it, then release the mutex.`;
      } else {
        const retained = outcome?.retainedLabels.length
          ? outcome.retainedLabels
          : additions;
        recovery = `Remove ${retained.join(", ")} by hand before releasing the mutex.`;
      }
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
    listRepoLabelNames,
    removeIssueLabels,
    withIssueMutationLock,
    ...overrides,
  };
  const number = options.issues[0];

  // `gh issue edit --add-label` fails on a label the repository does not
  // define, and inside the mutex that failure lands where this module can no
  // longer prove what the board holds, so it keeps LOCK for an operator. One
  // bounded read before the mutex is taken turns a typo, or a routing value
  // whose label was never created, into a refusal that never touches the
  // mutex. It reads repository labels, not the issue, so it adds nothing to
  // the serialized section and re-derives none of its decisions. Checking the
  // whole request rather than the additions costs nothing: deleting a
  // repository label removes it from every issue, so a label the issue already
  // carries is one the repository defines.
  const defined = await dependencies.listRepoLabelNames(options);
  const absent = labels.filter((label) => !defined.has(label));
  if (absent.length > 0) {
    throw new IssueGroomLabelRefusedError(
      `Issue #${number} groom refused: ${absent.join(", ")} is not a label ${options.repo} defines. gh issue edit fails on an unknown label only after the write is attempted, where this command keeps the per-issue mutex for an operator. Create the label from its canonical definition, or propose it for a human, then groom the issue again.`,
      { issue: number, requested: labels, absent },
    );
  }

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
