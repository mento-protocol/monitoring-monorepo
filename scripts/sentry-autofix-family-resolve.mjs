/**
 * Live-state family-resolution orchestration for the Sentry AUTOFIX selector
 * (scripts/sentry-autofix-select.mjs). Extracted from the selector so it stays
 * under the 600-line soft cap: the selector keeps the pure parse / evaluate /
 * report / CLI layers, and this module owns the transitive `duplicate_of`
 * collapse driven from LIVE queue state.
 *
 * `sentry-autofix-family.mjs` is the PURE union-find (`collapseDuplicateFamilies`
 * and friends); this module is the I/O-driven resolver ON TOP of it — it queries
 * `gh` (through the injected `runGh`, via the queue-io layer) to close the family
 * edges the forward `duplicate_of` graph cannot see, then drives the pure
 * collapse to a fixpoint. Every read is bounded and fails toward MORE candidates.
 */

import {
  collapseDuplicateFamilies,
  declaredFamilyIds,
  familyKey,
  isLocalFamilyId,
} from "./sentry-autofix-family.mjs";
import {
  listHandledShortIds,
  LOCAL_SENTRY_PROJECT,
  MAX_HANDLED_ID_QUERIES,
} from "./sentry-autofix-queue-io.mjs";
import {
  MAX_REVERSE_PROBE_QUERIES,
  MAX_REVERSE_VERIFY_READS,
  reverseVerifyFamilies,
} from "./sentry-autofix-reverse-verify.mjs";

// Reverse-verify fixpoint ceiling (PR #1810 bug B). A newly discovered blocker
// defers a finalist, which promotes the next candidate, which has its own family
// to probe — so the collapse must re-run until the finalist set is stable. The
// `alreadyProbed` set makes each id cost one search at most, so this ceiling is
// only a backstop; on hit it emits a stderr note and proceeds with the current
// candidates (fails OPEN — toward MORE candidates, the family module's safe
// direction).
const MAX_REVERSE_ITERATIONS = 4;

/**
 * Collapse the candidate window to per-family decisions, closing the family
 * edges the forward `duplicate_of` graph cannot see on its own:
 *   - bug C: a TERMINAL sibling that the candidate window excludes, found by
 *     querying each DECLARED family id directly (no bounded recent list, so a
 *     blocker deep in the ledger is still found);
 *   - bug B: a REVERSE edge — a handled sibling or hub id that names a finalist
 *     — found by probing each finalist's family member ids via `in:comments`,
 *     then folding the verified edges/blockers back in and re-collapsing. An
 *     admitted hub joins its WHOLE declared family, so a terminal sibling the hub
 *     names alongside the finalist is pulled into the family; the per-iteration
 *     handled-recheck then reads that reverse-surfaced id's own marker (its edge
 *     is otherwise the one the forward pass never declared and the reverse pass
 *     would drop).
 * Both budgets fail toward MORE candidates and thread their truncation out.
 * Returns `{ decisions, truncations }` — `truncations` carries the handled-id
 * overflow count and the reverse-probe / non-convergence flags for the run
 * record, so a bounded re-attempt is never silent.
 *
 * `options.budgets` ({ handled, probe, verify }) overrides the three per-RUN
 * caps for ONE call. The selector's bounded second look needs it: the first
 * pass has already SPENT the module defaults, so a second pass reusing them
 * would double the run's worst-case `gh` volume. Absent, the defaults apply and
 * behaviour is byte-identical to before the option existed.
 *
 * `options.seed` carries a PRIOR pass's resolved state into this one — the
 * `resolved` object this function returns. Only the selector's second look uses
 * it, and it is what keeps that pass from being strictly weaker than the pass it
 * follows. The precondition for a second look is that the first pass found a
 * blocker for EVERYTHING, so the run has already PROVEN those blockers exist;
 * without the seed the second look throws that proof away and asks a half-sized
 * budget to re-derive it from scratch, and every budget here fails OPEN toward
 * MORE candidates — so a family whose terminal sibling the first pass surfaced at
 * probe 25 is unreachable at 20 probes, and the second look selects a stub whose
 * family the same run just stood down. That is a duplicate autofix PR with no
 * rate limit involved. Seeding is also strictly cheaper: `handledAnswered`,
 * `probesAnswered` and `stubCache` make the second look skip reads the first pass
 * already paid for. Budgets are NOT seeded — they are fresh allowances for the
 * ids this pass is the first to see.
 *
 * The seed carries ANSWERED work only. Every set here has a wider in-pass twin
 * that also suppresses ids the pass DROPPED for budget or FAILED to read; those
 * twins never leave the pass. Seeding spend as if it were knowledge is the
 * inverse of the bug seeding exists to fix, and lands in the same place — a
 * duplicate autofix PR — from the other direction.
 */
export async function resolveFamilies(
  runGh,
  repo,
  candidates,
  cap,
  options = {},
) {
  const budgets = options.budgets ?? {};
  const handledCap = Number.isInteger(budgets.handled)
    ? budgets.handled
    : MAX_HANDLED_ID_QUERIES;
  const verifyCap = Number.isInteger(budgets.verify)
    ? budgets.verify
    : MAX_REVERSE_VERIFY_READS;
  const probeCap = Number.isInteger(budgets.probe)
    ? budgets.probe
    : MAX_REVERSE_PROBE_QUERIES;
  const seed = options.seed ?? {};
  const project = LOCAL_SENTRY_PROJECT;
  const candidateKeys = new Set(
    candidates.map((candidate) => familyKey(candidate.shortId)),
  );

  // bug C handled set, keyed per DECLARED family id (the distinct, project-scoped
  // and MAX_DUPLICATE_LOOKUPS-bounded union of every candidate's duplicate_of).
  // Gated on "any declared id exists": a window that declares nothing issues
  // zero handled queries, preserving the empty-window cost profile.
  const declaredIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        declaredFamilyIds(candidate.shortId, candidate.duplicateOf, project),
      ),
    ),
  ];
  // ANSWERED vs SPENT. Each pair below is the same distinction: the first member
  // is what this pass may not re-attempt (answered, dropped for budget, or
  // failed), the second is the strict subset that was actually ANSWERED and is
  // therefore knowledge a later pass may inherit. Only the answered halves reach
  // `resolved`, and each within-pass set STARTS from the seeded answered one —
  // so a fresh budget retries exactly what nobody ever read.
  //
  // Getting this wrong is a duplicate autofix PR. `listHandledShortIds` folds
  // every OVERFLOWED id into `queried` on purpose, so the per-run overflow counts
  // each distinct un-runnable id once instead of once per fixpoint iteration —
  // correct while a budget only shrinks within one pass, and silently wrong the
  // moment a pass with a FRESH budget inherits it: the second look would treat
  // never-read ids as resolved, spend none of its new allowance on them, and
  // select a stub whose sibling carries a terminal marker nobody ever looked at.
  const handledAnswered = new Set(seed.handledAnswered ?? []);
  const handledQueried = new Set(handledAnswered);
  const handledBudget = { remaining: handledCap, overflow: 0 };
  const probeBudget = { remaining: probeCap };
  // The stub cache negative-caches a FAILED read as `null` so one broken stub is
  // not re-read once per fixpoint iteration. That null is spend; `failedStubReads`
  // records which keys it covers so they can be dropped from the seed while the
  // in-pass cache keeps its bound.
  const failedStubReads = new Set();
  const stubCache =
    seed.stubCache instanceof Map ? new Map(seed.stubCache) : new Map();
  const probesAnswered = new Set(seed.probesAnswered ?? []);
  const alreadyProbed = new Set(probesAnswered);
  // One per-RUN verify-read budget for the reverse leg, shared across the fixpoint
  // so the total `gh issue view` fan-out over hit-verification is bounded (the
  // bug-B mirror of the probe-search cap: each search returns up to
  // REVERSE_SEARCH_LIMIT rows and every unseen row costs a verdict re-read).
  const reverseVerifyBudget = { remaining: verifyCap };
  let reverseBudgetTruncated = false;
  let reverseNonconvergent = false;

  // The seeded blockers/edges are the prior pass's PROVEN findings, folded in
  // before the first collapse so this pass never has to re-derive them (and, on
  // a smaller budget, fail to).
  let handledShortIds = [...new Set(seed.handledShortIds ?? [])];
  if (declaredIds.length) {
    const found = await listHandledShortIds(runGh, repo, declaredIds, {
      queried: handledQueried,
      answered: handledAnswered,
      budget: handledBudget,
    });
    handledShortIds = [...new Set([...handledShortIds, ...found])];
  }
  const handledEdges = [
    ...(Array.isArray(seed.handledEdges) ? seed.handledEdges : []),
  ];

  // Family ids are agent-authored free text. Scoping every joiner AND every
  // blocker to this project is what stops a foreign-project id — or the bare
  // project slug, which `isValidShortId` accepts — from unioning unrelated local
  // candidates into one starved family.
  const collapse = () =>
    collapseDuplicateFamilies(candidates, {
      handledShortIds,
      handledEdges,
      project,
    });

  let decisions = collapse();

  for (let iteration = 1; candidates.length > 0; iteration += 1) {
    // The would-be matrix entries this collapse produced: selected,
    // non-reconcile, within the cap — precisely the finalists whose families the
    // reverse check must verify. bug B's topology is a finalist that declares
    // nothing yet is named by a handled sibling, so the check runs whenever a
    // finalist exists, not only when a candidate declared an edge.
    const finalists = [];
    for (const decision of decisions) {
      if (finalists.length >= cap) break;
      if (decision.selected && !decision.candidate.reconcile) {
        finalists.push(decision);
      }
    }
    const memberIds = [
      ...new Set(finalists.flatMap((decision) => decision.members ?? [])),
    ];

    // Handled-recheck the family member ids the initial declared-id pass never
    // saw — the non-candidate hub ids the reverse edges surface (a terminal
    // sibling a hub names alongside the finalist, whose marker lives on its OWN
    // stub, not on any hit). Candidate ids are never terminal by construction;
    // already-handled and already-queried ids add nothing; foreign-project ids
    // stay inert. Shares the per-run handled budget, so it fails toward MORE
    // candidates rather than unbounded gh volume.
    const recheckIds = memberIds.filter(
      (id) =>
        !candidateKeys.has(id) &&
        !handledShortIds.includes(id) &&
        !handledQueried.has(id) &&
        isLocalFamilyId(id, project),
    );
    // Run the budgeted recheck whenever there ARE rechecks — even at zero
    // remaining capacity. The helper can't do lookups it has no budget for, but
    // it MUST still RECORD the overflow (increment handledOverflow) so an un-run
    // recheck surfaces on the run record instead of a SILENT truncation. Skipping
    // it at zero capacity (the prior `&& handledBudget.remaining > 0` guard) is
    // exactly that silent truncation: a nonterminal hub H that links finalist P
    // to a terminal sibling Q puts Q in recheckIds, and dropping the recheck
    // leaves Q's marker unread, redundantly selects P, AND reports overflow 0 —
    // byte-identical to a healthy run, the failure mode this PR's Window /
    // reverse-probe surfacing exists to eliminate.
    const newlyHandled =
      recheckIds.length > 0
        ? await listHandledShortIds(runGh, repo, recheckIds, {
            queried: handledQueried,
            answered: handledAnswered,
            budget: handledBudget,
          })
        : [];

    const probeIds = memberIds.filter((id) => !alreadyProbed.has(id));
    let edges = [];
    let blockers = [];
    if (probeIds.length > 0) {
      const result = await reverseVerifyFamilies(runGh, repo, probeIds, {
        project,
        stubCache,
        alreadyProbed,
        answeredProbes: probesAnswered,
        failedStubReads,
        verifyBudget: reverseVerifyBudget,
        probeBudget,
        maxProbes: probeCap,
      });
      edges = result.edges;
      blockers = result.blockers;
      if (result.truncated) reverseBudgetTruncated = true;
    }

    const foldedBlockers = [...new Set([...blockers, ...newlyHandled])];
    const newBlockers = foldedBlockers.filter(
      (id) => !handledShortIds.includes(id),
    );
    // Nothing new to fold -> the finalist set is stable.
    if (edges.length === 0 && newBlockers.length === 0) break;

    handledShortIds = [...new Set([...handledShortIds, ...foldedBlockers])];
    handledEdges.push(...edges);
    decisions = collapse();

    if (iteration >= MAX_REVERSE_ITERATIONS) {
      reverseNonconvergent = true;
      process.stderr.write(
        `note: reverse family verification did not reach a fixpoint in ${MAX_REVERSE_ITERATIONS} iterations; proceeding with the current candidates (fails open).\n`,
      );
      break;
    }
  }
  return {
    decisions,
    truncations: {
      handledOverflow: handledBudget.overflow,
      reverseBudget: reverseBudgetTruncated,
      reverseNonconvergent,
    },
    // Everything this pass LEARNED — and ONLY that — in the shape `options.seed`
    // accepts. The selector hands it to the second look so that pass starts from
    // this one's blockers and edges instead of re-deriving them on a smaller
    // budget. Deliberately absent: every id this pass dropped for budget, every
    // lookup and probe that failed, and every stub read that threw. Those are
    // spend, and the second look's budgets are FRESH, so it must be free to
    // retry exactly the work this pass could not afford. Carrying them would
    // read as "already resolved" and let a stub whose sibling holds a terminal
    // marker through as a duplicate fix PR.
    resolved: {
      handledShortIds,
      handledEdges,
      handledAnswered,
      probesAnswered,
      stubCache: new Map(
        [...stubCache].filter(([key]) => !failedStubReads.has(key)),
      ),
    },
  };
}
