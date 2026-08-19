#!/usr/bin/env node
/**
 * Revalidation and compensation for the architectural-hold backfill (issue
 * #1812). Extracted from scripts/sentry/autofix/sentry-autofix-record-labels.mjs (which sat
 * over the 600-line soft cap) so that module keeps the pure plan, the label
 * write and its CLI, and this one owns the two questions the write is bracketed
 * by: "is this hold still warranted?" and "how do we take it back?".
 *
 * The backfill is snapshot-driven — the selector's skip report describes state
 * as it was at select time — and GitHub labels have no atomic compare-and-set,
 * so every write here is bracketed by the SAME live check on both sides, the
 * shape of the #1389 stale-verdict guard. When the post-write check does not
 * re-confirm the hold, `withdrawStaleHold` takes the label back off and puts the
 * stub through the pipeline's own recovery entry point.
 */

import {
  FIX_SCOPE_MECHANICAL,
  resolveVerdict,
  validateAffectedRepo,
} from "../triage/sentry-triage-project-core.mjs";
import { FIX_SCOPE_ARCHITECTURAL_LABEL } from "../triage/sentry-triage-ingest.mjs";
import { readStub } from "./sentry-autofix-queue-io.mjs";
// The single-owner re-queue chokepoint (#1782). A withdrawn hold has to put the
// stub BACK in the pipeline, and this module is the only place allowed to build
// that sequence — so reuse it rather than hand-rolling a second requeue path.
import {
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_ON_FAILURE_VERIFY_END_STATE,
  requeueQueueStub,
} from "../triage/sentry-triage-requeue.mjs";
// The SAME terminal-state predicate the triage workflow's compensating re-queue
// guards on (`runWorkflowRequeue`). Reused rather than re-derived so "settled,
// and not ours to reopen" has one definition.
import { isTerminalStub } from "../triage/sentry-triage-workflow-requeue.mjs";

// The fixable verdict, mirrored from the selector (scripts/sentry/autofix/sentry-autofix-select.mjs
// AUTOFIX_VERDICT). The revalidation below re-reads through the SAME authoritative
// resolver the selector uses and re-applies the selector's own conditions.
const AUTOFIX_VERDICT = "code-fix";

/**
 * Re-read issue #<number>'s LIVE verdict through the SAME authoritative resolver
 * the selector uses (`readStub` -> `resolveVerdict`) and re-apply the selector's
 * own eligibility gate: still `code-fix`, its fix_scope still not `mechanical`,
 * AND its affected_repo still EXACTLY this repo (`validateAffectedRepo` reason
 * `local-repo` — not `allowed`, an allowlisted-external owner, nor
 * `unrecognized-repo`). The `sentry:fix-scope-architectural` hold is a LOCAL-only
 * exclusion; adding it to an issue whose live verdict now names an external
 * allowlisted repo would suppress that issue's projection (`runProjectionBatch`
 * skips a held stub) and leave it stuck — so the repo must be re-confirmed too,
 * exactly as the selector's `evaluateCandidate` requires before it can skip a
 * stub on scope.
 *
 * The skip report is a SNAPSHOT taken at select time; between the select run and
 * this record run an operator can re-triage #N from architectural to mechanical,
 * or to an external owning repo. Adding the exclusion label off the stale
 * snapshot would keep the now-selectable (or now-external) stub mislabeled. So
 * confirm scope AND repo against live state before labeling. Tri-state so the
 * caller can fail CLOSED:
 *  - "architectural": live verdict is still a LOCAL architectural code-fix — safe
 *                     to label.
 *  - "selectable":    live verdict is no longer a local architectural code-fix
 *                     (now `mechanical`, no longer `code-fix`, or no longer this
 *                     repo) — DO NOT label; leave the stub for its own leg to
 *                     handle.
 *  - "unconfirmed":   the verdict is gone or unreadable (read/parse error) — DO
 *                     NOT label; we cannot confirm scope, so fail closed and
 *                     leave the stub selectable (re-evaluated next run — self-heal).
 */
export async function liveArchitecturalScope(runGh, repo, number) {
  let full;
  try {
    full = await readStub(runGh, repo, number);
  } catch (err) {
    return {
      state: "unconfirmed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed;
  try {
    ({ parsed } = resolveVerdict(full, number));
  } catch (err) {
    return {
      state: "unconfirmed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const architectural =
    parsed.verdict === AUTOFIX_VERDICT &&
    parsed.fixScope !== FIX_SCOPE_MECHANICAL &&
    validateAffectedRepo(parsed.affectedRepo).reason === "local-repo";
  return { state: architectural ? "architectural" : "selectable" };
}

/**
 * Live `{ state, labels, comments }` for the re-queue chokepoint's `readStub`
 * dep. Separate from the queue-io `readStub` used for the verdict re-read,
 * because the selectability pair the chokepoint verifies (`--state open` AND
 * `sentry:needs-triage`) needs the issue STATE, which the autofix reader does
 * not request.
 */
async function readStubWithState(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,state,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    state: String(data.state ?? "").toUpperCase(),
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

/** The bookkeeping note the withdrawal re-queue posts. Fixed text — no Sentry-
 * or agent-derived input — and deliberately not a fence: nothing in Sentry moved,
 * so the operator's fresh verdict stays admissible and the re-triage can settle
 * on it. */
function buildWithdrawnHoldNote() {
  return (
    "Sentry autofix withdrew the `sentry:fix-scope-architectural` hold it had " +
    "just applied: the stub stopped resolving to a local architectural " +
    "code-fix between the record run's pre-write check and the label write " +
    "(most likely a concurrent re-triage), or that scope could not be " +
    "re-confirmed afterwards. Because projection may already have skipped this " +
    "stub on the stale hold, removing the label alone would leave it open with " +
    "no owning-repo issue and no retry path — so it is re-queued here for a " +
    "fresh triage round, which re-decides scope and re-runs projection."
  );
}

/**
 * Take back a hold this run just applied, then put the stub back in the
 * pipeline. Called only when the post-write check failed to re-confirm the hold.
 *
 * Returns `{ withdrawn, requeue }`: `withdrawn` false when the compensating
 * REMOVE itself failed (loud — a stuck hold is the strand this guard exists to
 * prevent, and it is reported by the caller); `requeue` one of `"requeued"`,
 * `"declined"` (settlement had already won — no compensation owed) or
 * `"failed"`, and null when the removal failed so no re-queue was attempted.
 * Never throws.
 */
export async function withdrawStaleHold(runGh, repo, number) {
  try {
    await runGh([
      "issue",
      "edit",
      number,
      "--repo",
      repo,
      "--remove-label",
      FIX_SCOPE_ARCHITECTURAL_LABEL,
    ]);
  } catch (err) {
    // A hold that cannot be withdrawn is exactly the strand this guard exists
    // to prevent, and the record-run job is continue-on-error — so it must not
    // pass silently. `::error::` annotates the run; the caller also buckets it.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `::error::could not remove the stale ${FIX_SCOPE_ARCHITECTURAL_LABEL} label from #${number} after a failed post-write check (${message}); the stub may be held out of both autofix selection and projection until a human clears the label.\n`,
    );
    return { withdrawn: false, requeue: null };
  }

  // Removing the label is not enough on its own: projection runs in the SAME
  // window and may already have read the stale hold, in which case
  // runProjectionBatch returned `skipped-state` (reason `architectural-open`)
  // and the workflow arm simply continued. Nothing re-runs projection for that
  // stub, so an external code-fix would sit open with no owning-repo issue and
  // no retry label — the same strand, one step later. Put it back through the
  // pipeline's own recovery entry point instead.
  //
  // Cause is BOOKKEEPING, not sentry-evidence: nothing in Sentry moved, this is
  // a compensation for our own write. That matters — a fencing cause would mark
  // the operator's fresh verdict stale and discard a valid re-triage, which is
  // precisely the verdict this stub should now settle on.
  //
  // VERIFY_END_STATE because this path has no reconciler behind it: the
  // chokepoint drives the stub to the selectable pair and READS it back, so a
  // partially-applied re-queue is corrected rather than reported as success.
  //
  // TERMINAL GUARD. Our premise is a snapshot too: we observed a stale hold and
  // decided to compensate. Projection and the archive leg hold their own
  // concurrency groups, so settlement can COMPLETE in that gap — and a
  // bookkeeping re-queue would then reopen a closed stub and shed
  // `sentry:projected` / `sentry:archived` through REOPEN_SHED_LABELS,
  // reversing a successful projection or a human-approved archive. So
  // revalidate against the same terminal predicate the triage workflow's
  // compensating re-queue uses and DECLINE when settlement has won: no
  // compensation is owed, because the outcome we were protecting has already
  // been reached by the pipeline itself. A declined re-queue is a correct
  // outcome, not a failure. A FAILED terminal read propagates out of the
  // chokepoint into the catch below — deliberately the safe direction: we do
  // not reopen a stub we could not confirm is non-terminal, since wrongly
  // reversing an approved archive is worse than one missed compensation, which
  // the next run's backfill re-detects from the same skip report.
  try {
    const outcome = await requeueQueueStub(
      {
        writeGh: (args) => runGh(args),
        readStub: (n) => readStubWithState(runGh, repo, n),
      },
      {
        repo,
        issueNumber: number,
        cause: REQUEUE_CAUSE_BOOKKEEPING,
        note: buildWithdrawnHoldNote(),
        revalidate: {
          check: (live) => !isTerminalStub(live),
          declineNote: (live) =>
            `Queue stub #${number} went terminal before the withdrawn-hold re-queue could run (state=${live.state}, labels=${live.labels.join(",") || "none"}); settlement completed on its own, so no compensation is owed and it is left settled rather than reopened over a projected or archived occurrence.`,
        },
        onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      },
    );
    if (outcome?.requeued === false && outcome.reason === "revalidated-away") {
      // The chokepoint already printed the decline note above.
      return { withdrawn: true, requeue: "declined" };
    }
    return { withdrawn: true, requeue: "requeued" };
  } catch (err) {
    // Same discipline as a failed withdrawal: the stub is now unlabeled but may
    // have been passed over by projection, so a re-queue that never landed is a
    // silent strand. The chokepoint already screams on its own end-state
    // failure; this makes the outcome visible in the summary too.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `::error::removed the stale ${FIX_SCOPE_ARCHITECTURAL_LABEL} label from #${number} but could not re-queue it for triage (${message}); if projection skipped this stub on the stale hold it will stay open with no owning-repo issue until it is re-queued by hand.\n`,
    );
    return { withdrawn: true, requeue: "failed" };
  }
}
