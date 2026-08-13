/**
 * The bounded SECOND LOOK for the Sentry AUTOFIX selector
 * (scripts/sentry-autofix-select.mjs). Extracted so the selector stays under the
 * 600-line soft cap: the selector keeps the window, the family orchestration,
 * the reporting and its CLI, and this module owns the one question "the first
 * pass found nothing and the list was full — what is past the ceiling?".
 *
 * The starvation it exists to break: every stub inside the window is a deferred
 * family member (or a fix_scope skip), so the run selects NOTHING and writes
 * NOTHING, and the next run reads the SAME window and repeats — forever.
 * Deferral is state-free by design, so nothing ages out; a selectable stub
 * sitting one row past the window is never evaluated, at any point, ever.
 *
 * It fires ONLY on that exact signature: zero matrix entries AND a FULL list
 * page (`rawCount >= LIST_LIMIT`, so rows beyond it may exist). A healthy run —
 * anything selected — never reaches it and pays nothing. It is not a retry and
 * not a widening: it reads the NEXT rows once, with its own hard ceilings, and
 * hands the caller everything needed to report that it ran AND any truncation of
 * its own.
 *
 * COST ARITHMETIC. Two units, and they are not the same number — conflating them
 * is how a "drift detector" ends up measured against a ceiling it cannot reach:
 *   - `gh` INVOCATIONS: what `state.ghCalls` counts and what the run record
 *     reports. One invocation = one serial subprocess ≈ one second of wall
 *     clock, so this is the unit the TIMEOUT is sized in.
 *   - API REQUESTS: what the rate limiter bills. A `gh issue list --limit N`
 *     paginates internally at 100 rows per request, so ONE invocation of it can
 *     be several requests.
 * Worst case, per run:
 *   first pass  = 1 list invocation (2 requests, 200 rows) + 2 × 200 per-stub
 *                 reads + 120 family budget (40 handled-id + 40 reverse probe +
 *                 40 verify read) = 521 invocations / 522 requests
 *   second look = 1 list invocation (3 requests: 300 rows) + 2 × 100 per-stub
 *                 reads + 60 family budget (20 each) = 261 invocations /
 *                 263 requests
 *   TOTAL       = 782 invocations ≈ 13.0 min at a pessimistic 1.0 s/call = 52%
 *                 of the 25-minute select timeout; 785 API requests.
 * Raising any constant here re-opens BOTH sums — the timeout above and
 * the per-bucket rate budget in docs/notes/sentry-triage-pipeline.md § "Cost
 * bound". The select suite pins the invocation total against
 * DOCUMENTED_GH_CEILING_WITH_SECOND_LOOK and pins the list `--limit` this module
 * asks for, which is the only term that makes the two units differ.
 */

import { evaluateCandidate } from "./sentry-autofix-candidate.mjs";
import { resolveFamilies } from "./sentry-autofix-family-resolve.mjs";
import { listCodeFixStubsPage } from "./sentry-autofix-queue-io.mjs";

/** How many stubs past the first window ONE second look may evaluate. Its own
 * hard ceiling, separate from MAX_CANDIDATE_EVALUATIONS, because this pass is
 * additive to a run that has already spent the first pass's whole budget. */
export const MAX_SECOND_LOOK_EVALUATIONS = 100;

/**
 * How many RAW rows past the first window the second look asks for. The list is
 * issued as ONE `gh issue list --limit <skip> + this`, with the first `<skip>`
 * raw rows dropped client-side — `gh issue list` has no offset flag, and a
 * raw-row skip is what lines up with the first pass's own `--limit` (applied
 * server-side, before any client filter).
 *
 * EQUAL to MAX_SECOND_LOOK_EVALUATIONS, and the same no-op invariant binds the
 * pair as binds MAX_CANDIDATE_EVALUATIONS / LIST_LIMIT: the row cap is applied
 * FIRST, so raising the evaluation cap above it reads exactly this many rows and
 * nothing says the raise did nothing. `secondLookCeilingWarning` re-checks the
 * pair at run time and a suite test pins it.
 *
 * It used to be 200 against an evaluation cap of 100 — 100 rows fetched on every
 * second look that were structurally unreachable, presented in this header as
 * part of the necessary cost of reaching 100 stubs. The truncation signal that
 * over-fetch bought (`total > evaluated`) saturated anyway: it read the same at
 * 200 further stubs and at 5,000. `full` below is that signal done properly.
 */
export const SECOND_LOOK_LIST_ROWS = 100;

/**
 * A run-time note when the second look's evaluation cap is configured above the
 * row cap that is applied first — the same silent-no-op shape
 * `windowCeilingWarning` guards for the first pass, on the pair this module
 * added. Generic invariant, so it gets a guard of its own rather than the
 * first pass's guard and a hope. Pure; returns the note, or null.
 */
export function secondLookCeilingWarning(
  evaluations = MAX_SECOND_LOOK_EVALUATIONS,
  listRows = SECOND_LOOK_LIST_ROWS,
) {
  if (!(evaluations > listRows)) return null;
  return `warn: MAX_SECOND_LOOK_EVALUATIONS (${evaluations}) exceeds SECOND_LOOK_LIST_ROWS (${listRows}), which the API applies FIRST — the second look really reads ${listRows} rows and raising the evaluation cap alone does nothing. Raise SECOND_LOOK_LIST_ROWS too.\n`;
}

/** The second look's OWN family budgets. The first pass's per-run budgets are
 * spent by the time it runs, so it cannot reuse them; half of each keeps the
 * total inside the arithmetic above while still letting a real family resolve. */
export const SECOND_LOOK_FAMILY_BUDGETS = {
  handled: 20,
  probe: 20,
  verify: 20,
};

/**
 * Read and resolve the rows past the first window. Returns
 * `{ decisions, truncations, total, evaluated, full }` — RAW decisions, not
 * reports: the caller partitions them through the same classifier its first pass
 * uses, so a second-look family deferral can never be reported as a fix_scope
 * skip (the two lift on different events and send an operator to different
 * remedies).
 *
 * `options.skipRawRows` is how many RAW rows the FIRST pass consumed — the
 * offset this pass starts at. It is a parameter rather than `LIST_LIMIT` because
 * the two coincide only while `MAX_CANDIDATE_EVALUATIONS === LIST_LIMIT`. The
 * moment the evaluation cap is lowered below the list ceiling (which the pin
 * permits, and which the Window tripwire is deliberately kept alive for), rows
 * between the eval cap and the list ceiling would be sliced away by the first
 * pass AND jumped over by a `LIST_LIMIT` skip here — a permanent hole in the
 * middle of the window, which is the exact starvation this module exists to
 * close. The caller passes `min(MAX_CANDIDATE_EVALUATIONS, LIST_LIMIT)`: since
 * filtered stubs are never more numerous than the raw rows they came from, N
 * evaluated stubs span at LEAST N raw rows, so this offset can only OVERLAP the
 * first pass, never skip past it. Overlap costs a re-read; a hole loses a stub
 * forever.
 *
 * `options.seed` is the first pass's resolved family state (see
 * `resolveFamilies`) — this pass starts from the blockers and edges the run has
 * already proven rather than re-deriving them on a smaller budget.
 *
 * `full` is the "there is MORE past even this" signal, taken off the raw row
 * count exactly like the first pass's. It is the honest replacement for the
 * `total > evaluated` truncation this pass used to report: `total` is clamped by
 * SECOND_LOOK_LIST_ROWS by construction, so it reads the same whether 100 or
 * 5,000 stubs sit past the ceiling, whereas `full` distinguishes "we reached the
 * end of the queue" from "the queue is growing past what one run can see".
 */
export async function resolveSecondLook(runGh, repo, cap, options = {}) {
  const skipRawRows =
    Number.isInteger(options.skipRawRows) && options.skipRawRows > 0
      ? options.skipRawRows
      : 0;
  const beyond = await listCodeFixStubsPage(runGh, repo, {
    limit: skipRawRows + SECOND_LOOK_LIST_ROWS,
    skip: skipRawRows,
  });
  const evaluable = beyond.stubs.slice(0, MAX_SECOND_LOOK_EVALUATIONS);
  if (beyond.stubs.length > evaluable.length) {
    process.stderr.write(
      `note: second look saw ${beyond.stubs.length} further stubs; evaluating the oldest ${evaluable.length} (MAX_SECOND_LOOK_EVALUATIONS).\n`,
    );
  }

  const candidates = [];
  for (const stub of evaluable) {
    const candidate = await evaluateCandidate(runGh, repo, stub);
    if (candidate) candidates.push(candidate);
  }
  // Its OWN family budgets: the first pass spent the per-run ones, so reusing
  // them would silently double the run's worst-case volume. Its own budgets over
  // the first pass's KNOWLEDGE, though — see the `seed` note above.
  const { decisions, truncations } = await resolveFamilies(
    runGh,
    repo,
    candidates,
    cap,
    { budgets: SECOND_LOOK_FAMILY_BUDGETS, seed: options.seed },
  );
  return {
    decisions,
    truncations,
    total: beyond.stubs.length,
    evaluated: evaluable.length,
    full: beyond.full,
  };
}
