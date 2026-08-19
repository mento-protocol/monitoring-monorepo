/**
 * The HANDLED-FAMILY lookup for the Sentry AUTOFIX selection leg: given the
 * `duplicate_of` family ids a window declared, which of them already carry a
 * TERMINAL autofix marker — and the per-run budget that bounds how many of them
 * one run may ask about.
 *
 * Extracted from scripts/sentry/autofix/sentry-autofix-queue-io.mjs. That file was at 583 of
 * the 600-line soft cap (docs/pr-checklists/recurring-review-patterns.md) — not
 * over it, but with too little headroom for the next change, which is how the
 * checklist's split-not-append rule gets hit late. This is the seam that leaves
 * both sides room: one exported lookup plus the one constant that bounds it,
 * with the budget / `queried` / `answered` accounting that only it reads.
 *
 * The dependency runs ONE WAY: this module imports the queue-stub vocabulary
 * from `sentry-autofix-queue-io.mjs` (the queue label, the owning project and
 * the title parser), and that module imports nothing from here — its importers
 * come to this path directly, no re-export shim, exactly as the I/O module's own
 * header requires of its exports. So no ESM cycle is reachable from this split.
 *
 * `runGh` is injectable for the same reason it is there: the select suite drives
 * the whole flow with mocked I/O. Nothing here writes.
 */

import { parseShortId } from "../triage/sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
} from "../triage/sentry-triage-ingest.mjs";
import { familyKey } from "./sentry-autofix-family.mjs";
import {
  LOCAL_SENTRY_PROJECT,
  parseProject,
  SENTRY_TRIAGE_QUEUE_LABEL,
} from "./sentry-autofix-queue-io.mjs";

/**
 * How many distinct declared family ids one run may look up — a per-RUN budget,
 * shared across the initial declared-id pass AND the fixpoint's re-checks of
 * reverse-surfaced hub ids (see `resolveFamilies`). Each candidate's fan-out is
 * already MAX_DUPLICATE_LOOKUPS-bounded, but the distinct union across a full
 * window (plus the ids the reverse probe surfaces) could still be large; overflow
 * ids are treated as NOT-handled — failing toward MORE candidates, the family
 * module's documented safe direction — with a stderr note AND a run-record line
 * (the overflow count is threaded out through the shared `budget`).
 *
 * This is one of the caps the finalize suite's select-job timeout pin derives
 * its worst-case `gh` call count from, so this module routes to that suite too
 * (scripts/agent-quality-gate.sh).
 */
export const MAX_HANDLED_ID_QUERIES = 40;

/**
 * Family keys that already carry a TERMINAL autofix marker
 * (`sentry:fix-pr-opened` / `sentry:fix-refused`) — the family-collapse input
 * `listCodeFixStubs` structurally cannot provide, because it excludes exactly
 * these stubs from the candidate window. Without it, a refused representative
 * strands its family: after `ANALYTICS-MENTO-ORG-2E` (#1304) was refused, its
 * four siblings are the only members left in the window, each pointing back at a
 * stub the selector can no longer see, so they return one per run and re-burn
 * the cap on a root cause the leg already declined.
 *
 * Keyed on the DECLARED id, not a position in a recent window (PR #1810 bug C).
 * The prior design listed both terminal-marker sets in bulk
 * (`sort:created-desc --limit 200`) and read a candidate's siblings out of that
 * recent slice — so a blocker sitting past row 200 (a terminal sibling deep in
 * the ledger) was invisible and its family re-attempted forever. Here each
 * declared id `<ID>` runs ONE query `"<ID>" in:title label:"sentry-triage"`,
 * then the exactly-matching stub's labels decide it: keyed on the referenced id,
 * a terminal sibling 500 stubs deep is still found, and truncation is
 * structurally impossible at any ledger size.
 *
 * ONE query covers BOTH markers with no OR-label syntax: the search narrows to
 * queue stubs of this family, and the marker check is client-side off the
 * returned labels. The parsed-short-id + project recheck fences GitHub's
 * tokenized search, so a fuzzy near-miss (a different suffix that tokenizes the
 * same) is dropped.
 */
export async function listHandledShortIds(
  runGh,
  repo,
  declaredIds,
  options = {},
) {
  // `queried` (ids this pass must not re-attempt — answered, dropped OR failed)
  // and `budget` (remaining allowance + accumulated overflow) are shared across
  // the run's calls, so a second pass on reverse-surfaced ids neither re-queries
  // an id nor exceeds the per-run cap. Absent (a standalone call), each defaults
  // fresh, preserving the single-call cap-at-40 behaviour exactly.
  //
  // `answered` is the STRICT SUBSET of `queried` whose lookup actually came back
  // and could be read — knowledge, where the rest of `queried` is merely spend
  // (it deliberately absorbs ids this call never issued; see the overflow
  // branch). Only that subset may cross into a pass with a FRESH budget. Why
  // that matters: sentry-autofix-family-resolve.mjs § ANSWERED vs SPENT.
  const queried = options.queried instanceof Set ? options.queried : new Set();
  const answered =
    options.answered instanceof Set ? options.answered : new Set();
  const budget = options.budget ?? {
    remaining: MAX_HANDLED_ID_QUERIES,
    overflow: 0,
  };
  const ids = [
    ...new Set(
      (Array.isArray(declaredIds) ? declaredIds : [])
        .map((id) => familyKey(id))
        .filter((id) => id.length > 0),
    ),
  ].filter((id) => !queried.has(id));
  const capacity = Math.max(0, budget.remaining ?? 0);
  const queryIds = ids.slice(0, capacity);
  const droppedIds = ids.slice(queryIds.length);
  if (droppedIds.length > 0) {
    budget.overflow = (budget.overflow ?? 0) + droppedIds.length;
    // Mark the un-run ids as queried too. The budget is shared across the run's
    // calls — the declared-id pass AND the fixpoint's rechecks — and a recheck
    // re-surfaces the same member ids every iteration; without this, one
    // un-runnable id would be re-counted into overflow once per iteration. The
    // per-run overflow must reflect each DISTINCT un-runnable id once. It is also
    // correct on its face: the budget is spent, so a later pass must not
    // re-attempt these ids either.
    for (const droppedId of droppedIds) queried.add(droppedId);
    process.stderr.write(
      // The budget is passed in, so name what is LEFT rather than the module
      // constant: the selector's bounded second look runs this same helper on a
      // smaller allowance, and printing MAX_HANDLED_ID_QUERIES there would point
      // an operator at a number the pass never had.
      `note: ${ids.length} distinct declared family ids exceed this pass's remaining handled-id lookup budget (${capacity} left, per-run cap ${MAX_HANDLED_ID_QUERIES}); ${droppedIds.length} are treated as not-handled this run (fails toward MORE candidates).\n`,
    );
  }
  budget.remaining = capacity - queryIds.length;
  const handled = new Set();
  for (const id of queryIds) {
    queried.add(id);
    let stdout;
    try {
      stdout = await runGh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `"${id}" in:title label:"${SENTRY_TRIAGE_QUEUE_LABEL}"`,
        "--json",
        "number,title,labels",
        "--limit",
        "20",
      ]);
    } catch (err) {
      // Fail-SOFT per id, matching the reverse `in:comments` probe: a transient
      // GitHub/subprocess failure on ONE lookup must not reject the whole call
      // and abort the select job under `set -euo pipefail` — that breaks the
      // "select ALWAYS emits a valid JSON array … never a failure" invariant the
      // workflow header asserts. Treat THIS id as not-handled this run (it stays
      // a candidate — fails toward MORE candidates) and continue so the other ids
      // still resolve. The id is already marked `queried` and budget-spent above,
      // so it is not re-attempted.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `skip handled-id lookup for ${id}: ${message}; treated as not-handled this run (fails toward MORE candidates).\n`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // A body we cannot read did not ANSWER the lookup any more than a failed
      // read did, so this id stays out of `answered`. Behaviourally identical to
      // the previous `parsed = []` (the loop below ran zero times either way).
      continue;
    }
    // ANSWERED: the lookup ran and came back readable. Both outcomes count —
    // "this id carries a terminal marker" and "it does not" are equally real
    // answers, and re-asking on a later pass would only re-spend budget.
    answered.add(id);
    for (const issue of Array.isArray(parsed) ? parsed : []) {
      const title = issue.title ?? "";
      // Exact-parse fence over GitHub's tokenized search: the parsed short-id
      // AND the parsed project must match this id exactly.
      if (familyKey(parseShortId(title)) !== id) continue;
      if (parseProject(title) !== LOCAL_SENTRY_PROJECT) continue;
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean);
      if (
        labels.includes(FIX_PR_OPENED_LABEL) ||
        labels.includes(FIX_REFUSED_LABEL)
      ) {
        handled.add(id);
        break;
      }
    }
  }
  return [...handled];
}
