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
 * COST ARITHMETIC (the constraint: first pass + second look must stay under
 * ~60% of the 25-minute select timeout at a pessimistic 1.0 s/call — every `gh`
 * call in this leg is serial, no `Promise.all` anywhere, so ~900 calls is the
 * wall):
 *   first pass  = 2 list pages + 2 × 200 per-stub reads + 120 family budget
 *                 (40 handled-id + 40 reverse probe + 40 verify read) = 522
 *   second look = 4 list pages (one `--limit 400` call, 100 rows per page)
 *               + 2 × 100 per-stub reads + 60 family budget (20 each) = 264
 *   TOTAL       = 786 calls ≈ 13.1 min at 1.0 s/call = 52% of 25 min. Under the
 *                 15-minute (≈900-call) wall with ~2 minutes of slack.
 * Raising any constant here re-opens that arithmetic; the select suite pins the
 * total against DOCUMENTED_GH_CEILING_WITH_SECOND_LOOK.
 */

import { evaluateCandidate } from "./sentry-autofix-candidate.mjs";
import { resolveFamilies } from "./sentry-autofix-family-resolve.mjs";
import {
  listCodeFixStubsPage,
  LIST_LIMIT,
} from "./sentry-autofix-queue-io.mjs";

/** How many stubs past the first window ONE second look may evaluate. Its own
 * hard ceiling, separate from MAX_CANDIDATE_EVALUATIONS, because this pass is
 * additive to a run that has already spent the first pass's whole budget. */
export const MAX_SECOND_LOOK_EVALUATIONS = 100;

/** How many RAW rows past the first window the second look asks for. The list is
 * issued as ONE `gh issue list --limit LIST_LIMIT + this`, with the first
 * LIST_LIMIT raw rows dropped client-side — `gh issue list` has no offset flag,
 * and a raw-row skip is what lines up with the first pass's own `--limit`
 * (applied server-side, before any client filter). */
export const SECOND_LOOK_LIST_ROWS = 200;

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
 * `{ decisions, truncations, total, evaluated }` — RAW decisions, not reports:
 * the caller partitions them through the same classifier its first pass uses, so
 * a second-look family deferral can never be reported as a fix_scope skip (the
 * two lift on different events and send an operator to different remedies).
 *
 * `total` vs `evaluated` is the second look's own truncation signal, surfaced by
 * the caller exactly like the Window tripwire — this pass must not silently stop
 * short either.
 */
export async function resolveSecondLook(runGh, repo, cap) {
  const beyond = await listCodeFixStubsPage(runGh, repo, {
    limit: LIST_LIMIT + SECOND_LOOK_LIST_ROWS,
    skip: LIST_LIMIT,
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
  // them would silently double the run's worst-case volume.
  const { decisions, truncations } = await resolveFamilies(
    runGh,
    repo,
    candidates,
    cap,
    { budgets: SECOND_LOOK_FAMILY_BUDGETS },
  );
  return {
    decisions,
    truncations,
    total: beyond.stubs.length,
    evaluated: evaluable.length,
  };
}
