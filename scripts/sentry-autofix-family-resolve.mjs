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
 */
export async function resolveFamilies(runGh, repo, candidates, cap) {
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
  // One per-RUN handled-id budget, shared by the initial declared-id pass and the
  // fixpoint's re-checks of reverse-surfaced hub ids, so the total stays bounded
  // and its overflow surfaces on the tracker.
  const handledQueried = new Set();
  const handledBudget = { remaining: MAX_HANDLED_ID_QUERIES, overflow: 0 };
  const stubCache = new Map();
  const alreadyProbed = new Set();
  // One per-RUN verify-read budget for the reverse leg, shared across the fixpoint
  // so the total `gh issue view` fan-out over hit-verification is bounded (the
  // bug-B mirror of the probe-search cap: each search returns up to
  // REVERSE_SEARCH_LIMIT rows and every unseen row costs a verdict re-read).
  const reverseVerifyBudget = { remaining: MAX_REVERSE_VERIFY_READS };
  let reverseBudgetTruncated = false;
  let reverseNonconvergent = false;

  let handledShortIds = declaredIds.length
    ? await listHandledShortIds(runGh, repo, declaredIds, {
        queried: handledQueried,
        budget: handledBudget,
      })
    : [];
  const handledEdges = [];

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
    const newlyHandled =
      recheckIds.length > 0 && handledBudget.remaining > 0
        ? await listHandledShortIds(runGh, repo, recheckIds, {
            queried: handledQueried,
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
        verifyBudget: reverseVerifyBudget,
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
  };
}
