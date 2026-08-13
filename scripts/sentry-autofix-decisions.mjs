/**
 * Decision → report classification for the Sentry AUTOFIX selector
 * (scripts/sentry-autofix-select.mjs). Extracted so the selector stays under the
 * 600-line soft cap: it owns the window, the family orchestration and the CLI,
 * and this module owns the one question "what does each family decision MEAN to
 * an operator reading the tracker?".
 *
 * Both the first pass and the bounded second look run through it, which is the
 * point: a second look that reported a family DEFERRAL as a fix_scope SKIP would
 * send an operator to the wrong remedy — a deferral lifts when a sibling's
 * marker goes away, a skip only when a re-triage supplies a new verdict.
 *
 * PURE except for the stderr diagnostics, which are the deferral's only live
 * trace inside a workflow log (the durable one is the run record the caller
 * builds from these arrays).
 */

import {
  DEFER_FAMILY_DUPLICATE,
  DEFER_FAMILY_HANDLED,
  DEFER_FAMILY_RECONCILING,
} from "./sentry-autofix-family.mjs";
import { safeShortId } from "./sentry-autofix-candidate.mjs";

/** One note per deferral reason, keyed by the collapse's own constants so a
 * reason added there cannot silently inherit another's wording. An unmapped
 * reason still prints — as itself, not as somebody else's explanation. */
const DEFER_NOTES = {
  [DEFER_FAMILY_DUPLICATE]: (decision) =>
    `same duplicate_of family as ${safeShortId(decision.representative)}, which represents the family this run`,
  [DEFER_FAMILY_HANDLED]: (decision) =>
    `its duplicate_of family already has an autofix attempt on ${safeShortId(decision.representative)} (a regression sheds that marker)`,
  [DEFER_FAMILY_RECONCILING]: () =>
    "its duplicate_of family already has an open autofix PR being reconciled this run",
};

/** Split one resolve pass's decisions into the three reported halves:
 * `{ entries, deferred, skipped }`. */
export function partitionDecisions(decisions, cap) {
  const entries = [];
  const deferred = [];
  const skipped = [];
  for (const decision of decisions) {
    const number = decision.candidate.issue;
    // Ruled out before the collapse ran (fix_scope). It joined the union so its
    // family edges survived, but it is not a family deferral and must not be
    // reported as one: the two lift on different events.
    if (decision.candidate.eligible === false) {
      skipped.push({ issue: number, reason: decision.candidate.skipReason });
      continue;
    }
    if (!decision.selected) {
      // Deferral writes NOTHING to the queue — no label, no comment, no marker.
      // The member stays exactly as selectable as its live state makes it on the
      // next run, which is what lets a genuine regression (ingest sheds the
      // sibling's autofix marker) bring the family straight back. It IS reported
      // out, though: the run record carries the count and the issue numbers so
      // "everything suppressed" never reads as "nothing queued".
      process.stderr.write(
        `defer #${number}: ${DEFER_NOTES[decision.reason]?.(decision) ?? `deferred (${decision.reason})`}; not marked, re-evaluated next run.\n`,
      );
      deferred.push({ issue: number, reason: decision.reason });
      continue;
    }
    if (entries.length >= cap) continue;
    entries.push(decision.candidate.entry);
  }
  return { entries, deferred, skipped };
}
