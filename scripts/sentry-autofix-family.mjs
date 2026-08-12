/**
 * Duplicate-FAMILY collapse for the Sentry autofix selector (issue #1784).
 *
 * PURE — no I/O, no `gh`, no writes. The selector
 * (scripts/sentry-autofix-select.mjs) owns every GitHub read and is the only
 * caller; this module only decides which of an already-evaluated candidate set
 * may consume an autofix run.
 *
 * WHY: triage already computes the Sentry issue family and writes it into the
 * verdict as `duplicate_of`, but the selector treated every queue stub as an
 * independent candidate. The one time the leg had work, stubs #1304, #1313,
 * #1316, #1326 and #1328 all resolved to `ANALYTICS-MENTO-ORG-2E` with the same
 * proposed action and all five ended `sentry:fix-refused` — five runs, one root
 * cause, and a refusal record that read as five independent failures.
 *
 * THREE PROPERTIES THIS MODULE OWNS:
 *
 *  1. TRANSITIVE union. The family graph is DIRECTIONAL: #1304's verdict listed
 *     SIX duplicates while the other four each pointed back only at `2E`.
 *     Following one direction alone splits the family — and the per-stub lookup
 *     budget (MAX_DUPLICATE_LOOKUPS = 5) truncates #1304's six-entry list, so
 *     the back-pointers are what re-attach the tail. A member id that is not
 *     itself a candidate still CONNECTS (`2E` may already carry a terminal
 *     marker and be filtered out of the window entirely, leaving its four
 *     children joined only through it), so the union runs over ids, not over
 *     candidates.
 *
 *  2. Representative = the stub the others point AT (highest in-degree among
 *     the family's candidates), falling back to the OLDEST candidate — the
 *     caller passes the list oldest-first, so "earliest index" is "oldest".
 *
 *  3. Deferral is NOT permanent, and writes NOTHING. `duplicate_of` is a
 *     same-culprit/message FAMILY signal, not a confirmed-duplicate assertion
 *     (scripts/sentry-triage-project-core.mjs states this at its definition), so
 *     a deferred member must stay able to reopen when it genuinely regresses.
 *     A deferred member is simply not emitted this run: no label, no comment,
 *     no marker. Its selectability is recomputed from live state on the next
 *     run, and ingest's regression path (REOPEN_SHED_LABELS) sheds the sibling
 *     marker that blocked it — so the family reopens by construction, with no
 *     new machinery and no second re-queue owner.
 *
 * TRUST. `duplicate_of` is agent-authored and therefore untrusted, and this
 * module acts on it. Every effect it can have is SUPPRESSIVE: the worst a
 * hostile or simply wrong list achieves is that a stub does not get an autofix
 * attempt this run. It cannot cause a write, cannot select a stub that failed
 * any other filter, cannot widen the cap, and cannot reach an issue outside the
 * queue — the caller emits nothing but the entries it built before asking. That
 * asymmetry is deliberate: over-collapsing costs a delayed fix an operator can
 * force with a single-issue dispatch, while under-collapsing costs a real run
 * per stub. The ids themselves are shape-validated (`isValidShortId`) at every
 * entry point here, so none can carry a newline into a rendered log line.
 */

import {
  isValidShortId,
  MAX_DUPLICATE_LOOKUPS,
} from "./sentry-triage-project-core.mjs";

/**
 * Defensive ceiling on how many SHORT-IDs ONE collapsed family may span. Each
 * candidate's fan-out is already bounded by MAX_DUPLICATE_LOOKUPS, but the
 * union is transitive, so a chain of agent-authored lists could otherwise join
 * an unbounded number of ids into a single family and defer the whole queue
 * behind one representative. A merge that would cross this ceiling is REFUSED —
 * the two families stay separate, which yields MORE candidates (each still
 * capped by the run's `--cap`), never fewer. Failing toward "attempt a fix" is
 * the safe direction here: over-collapsing silently starves the queue.
 */
export const MAX_FAMILY_MEMBERS = 40;

/** Why a candidate was not emitted this run. */
export const DEFER_FAMILY_DUPLICATE = "family-duplicate";
export const DEFER_FAMILY_HANDLED = "family-handled";
export const DEFER_FAMILY_RECONCILING = "family-reconciling";

/**
 * Family key for a SHORT-ID. Sentry SHORT-IDs are case-stable, but the autofix
 * branch name lowercases them and the verdict's `duplicate_of` is agent-typed,
 * so grouping is case-insensitive — the same rule the branch derivation already
 * applies. Keying only; the candidate's own SHORT-ID is what ever gets emitted.
 */
export function familyKey(shortId) {
  return String(shortId ?? "").toUpperCase();
}

/**
 * The bounded set of OTHER family ids one candidate declares. Mirrors the
 * projection leg's consumption rule exactly: drop the stub's own SHORT-ID
 * FIRST, then apply the MAX_DUPLICATE_LOOKUPS budget — capping before the
 * self-exclusion would let a self-reference eat the budget and push a real
 * family member past the cap. Shape-invalid entries are dropped (the parser's
 * `sanitizeDuplicateIds` already did this; re-checking here keeps the module
 * safe for any caller).
 */
export function declaredFamilyIds(shortId, duplicateOf) {
  const self = familyKey(shortId);
  const out = new Set();
  for (const raw of Array.isArray(duplicateOf) ? duplicateOf : []) {
    if (!isValidShortId(raw)) continue;
    const key = familyKey(raw);
    if (key === self) continue;
    out.add(key);
    if (out.size >= MAX_DUPLICATE_LOOKUPS) break;
  }
  return [...out];
}

/** Union-find over SHORT-ID keys, with a hard per-family member ceiling. */
function makeUnionFind() {
  const parent = new Map();
  const members = new Map();

  function add(key) {
    if (parent.has(key)) return;
    parent.set(key, key);
    members.set(key, new Set([key]));
  }

  function find(key) {
    add(key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return true;
    const setA = members.get(rootA);
    const setB = members.get(rootB);
    // Defensive ceiling: refuse the merge rather than growing without bound.
    if (setA.size + setB.size > MAX_FAMILY_MEMBERS) return false;
    for (const member of setB) {
      parent.set(member, rootA);
      setA.add(member);
    }
    members.delete(rootB);
    return true;
  }

  return { add, find, union, membersOf: (key) => members.get(find(key)) };
}

/**
 * Collapse an oldest-first candidate list to one selectable candidate per
 * duplicate family.
 *
 * `candidates`: `[{ shortId, duplicateOf, reconcile }]` — whatever else the
 * caller carries on each record is passed straight back untouched.
 * `options.handledShortIds`: SHORT-IDs of stubs that already carry a terminal
 * autofix marker (`sentry:fix-pr-opened` / `sentry:fix-refused`). Those stubs
 * are filtered out of the candidate window by the selector's own query, so
 * without this set a refused representative's four siblings would come back
 * one per run — the exact 5-runs-for-1-cause failure.
 *
 * Returns one decision per input candidate, IN INPUT ORDER:
 *   `{ candidate, selected, reason, representative }`
 * — `reason`/`representative` are null on a selected candidate.
 */
export function collapseDuplicateFamilies(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const handled = new Set(
    [...(options.handledShortIds ?? [])]
      .filter((id) => isValidShortId(id))
      .map(familyKey),
  );

  const uf = makeUnionFind();
  const inDegree = new Map();
  for (const candidate of list) {
    const key = familyKey(candidate.shortId);
    uf.add(key);
    for (const dup of declaredFamilyIds(
      candidate.shortId,
      candidate.duplicateOf,
    )) {
      uf.union(key, dup);
      inDegree.set(dup, (inDegree.get(dup) ?? 0) + 1);
    }
  }

  // A RECONCILE entry is not a fix attempt — it relinks a PRIOR run's open PR
  // and runs no agent — so it is never collapsed away (dropping it would leave
  // that stub's queue side-effects permanently unrepaired). But its family DOES
  // already have an open autofix PR for the shared root cause, so no sibling of
  // it may open a second one.
  const reconcilingRoots = new Set();
  for (const candidate of list) {
    if (candidate.reconcile) {
      reconcilingRoots.add(uf.find(familyKey(candidate.shortId)));
    }
  }

  // Group the fix candidates by family root, preserving input (oldest-first)
  // order within each family.
  const families = new Map();
  for (const candidate of list) {
    if (candidate.reconcile) continue;
    const root = uf.find(familyKey(candidate.shortId));
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(candidate);
  }

  const decisions = new Map();
  for (const [root, members] of families) {
    // A sibling anywhere in the family already consumed this family's attempt.
    // Sorted so the reported blocker does not depend on union order.
    const blocker =
      [...uf.membersOf(root)].sort().find((id) => handled.has(id)) ?? null;
    if (blocker) {
      for (const candidate of members) {
        decisions.set(candidate, {
          selected: false,
          reason: DEFER_FAMILY_HANDLED,
          representative: blocker,
        });
      }
      continue;
    }
    if (reconcilingRoots.has(root)) {
      for (const candidate of members) {
        decisions.set(candidate, {
          selected: false,
          reason: DEFER_FAMILY_RECONCILING,
          representative: null,
        });
      }
      continue;
    }
    // Representative: highest in-degree (the stub the others point AT), ties
    // broken by input order — which is oldest-first.
    let representative = members[0];
    let best = inDegree.get(familyKey(representative.shortId)) ?? 0;
    for (const candidate of members.slice(1)) {
      const degree = inDegree.get(familyKey(candidate.shortId)) ?? 0;
      if (degree > best) {
        best = degree;
        representative = candidate;
      }
    }
    for (const candidate of members) {
      decisions.set(
        candidate,
        candidate === representative
          ? { selected: true, reason: null, representative: null }
          : {
              selected: false,
              reason: DEFER_FAMILY_DUPLICATE,
              representative: representative.shortId,
            },
      );
    }
  }

  return list.map((candidate) => {
    const decision = decisions.get(candidate) ?? {
      selected: true,
      reason: null,
      representative: null,
    };
    return { candidate, ...decision };
  });
}
