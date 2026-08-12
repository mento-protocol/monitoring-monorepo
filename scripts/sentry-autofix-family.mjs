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
 *     candidates. For the same reason a candidate the CALLER has already ruled
 *     out (`eligible: false` — e.g. a `fix_scope: architectural` verdict, issue
 *     #1785) is still passed in and still contributes its ids: dropping it
 *     would DELETE its edges, and a family whose only edge-carrier was ruled
 *     out silently fans back out into one agent run per member. It contributes
 *     edges and nothing else — never selected, never counted as a deferral.
 *
 *  2. Representative = the OLDEST candidate in the family. The caller passes the
 *     list oldest-first, so that is simply the family's earliest index, and it
 *     is the ONE ordering agent text cannot forge: `createdAt` is GitHub's.
 *     An earlier revision ranked by in-degree (how many verdicts name an id),
 *     which is a raw count an attacker sets by creating more Sentry issues that
 *     name their chosen id — five noise stubs pointing at each other outrank a
 *     real bug and take the family's run. In-degree also broke the queue's
 *     oldest-first guarantee outright: decisions come back in INPUT order and
 *     the caller applies its cap over that order, so a family represented by a
 *     LATE member occupied that member's slot, and newer independent candidates
 *     could push the whole family past the cap on every run — permanently
 *     starving the queue's oldest candidate, which is exactly what
 *     `sort:created-asc` exists to prevent. Oldest-first restores it by
 *     construction: the family's decision sits at its oldest member's index.
 *     Family membership may therefore SUPPRESS a candidate, but never REORDER
 *     the queue.
 *
 *  3. Deferral writes NOTHING, and lifts when the blocking state does.
 *     `duplicate_of` is a same-culprit/message FAMILY signal, not a
 *     confirmed-duplicate assertion (scripts/sentry-triage-project-core.mjs
 *     states this at its definition), so a deferred member must stay able to
 *     reopen. A deferred member is simply not emitted this run: no label, no
 *     comment, no marker. Its selectability is recomputed from live state on the
 *     next run. What that does NOT mean is "temporary by construction": a
 *     DEFER_FAMILY_HANDLED block lifts only when the blocking stub's terminal
 *     marker goes away — ingest's regression path (REOPEN_SHED_LABELS) sheds it
 *     when that Sentry issue regresses, or a human removes it. A blocker that is
 *     fixed and stays fixed, or refused and stays quiet, keeps blocking. The
 *     caller therefore REPORTS every deferral into the run record (PR #1810),
 *     so a family-starved queue is distinguishable from an idle one and an
 *     operator can override with a single-issue dispatch.
 *
 * TRUST. `duplicate_of` is agent-authored and therefore untrusted, and this
 * module acts on it. Every effect it can have is SUPPRESSIVE: the worst a
 * hostile or simply wrong list achieves is that a stub does not get an autofix
 * attempt this run. It cannot cause a write, cannot select a stub that failed
 * any other filter, cannot widen the cap, cannot reorder the queue, and cannot
 * reach an issue outside the queue — the caller emits nothing but the entries it
 * built before asking. That asymmetry is deliberate: over-collapsing costs a
 * delayed fix an operator can force with a single-issue dispatch, while
 * under-collapsing costs a real run per stub. The ids themselves are
 * shape-validated (`isValidShortId`) AND project-scoped (`isLocalFamilyId`) at
 * every entry point here, so none can carry a newline into a rendered log line
 * and none can join two candidates through a foreign or degenerate id.
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
 * True when a SHORT-ID belongs to `project` — `<PROJECT-SLUG>-<SUFFIX>`, with a
 * non-empty suffix.
 *
 * `isValidShortId` alone is far too loose to gate family membership. Its pattern
 * (`^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9]+$`) accepts ANY hyphenated token, so
 * without this two unrelated local candidates union into one family through:
 *   - a FOREIGN-project id (`APP-MENTO-ORG-7X`) — and the union is asymmetric,
 *     because the caller's handled-marker read is already project-filtered, so a
 *     foreign id can only ever widen a family, never block one; and
 *   - the bare project SLUG itself (`ANALYTICS-MENTO-ORG`), which validates —
 *     one degenerate token in six verdicts collapses six independent bugs into
 *     one family, served one per run, forever.
 * Neither id can ever be a candidate (the selector only ever evaluates stubs of
 * THIS project), so their only possible role is as a joiner between real
 * candidates — precisely the over-collapse this refuses. Scoping loses nothing
 * real and makes both inert.
 */
export function isLocalFamilyId(id, project) {
  if (!isValidShortId(id)) return false;
  const slug = familyKey(project);
  if (!slug) return false;
  const prefix = `${slug}-`;
  const key = familyKey(id);
  return key.length > prefix.length && key.startsWith(prefix);
}

/**
 * The bounded set of OTHER family ids one candidate declares, restricted to
 * `project`. Mirrors the projection leg's consumption rule exactly: drop the
 * stub's own SHORT-ID FIRST, then apply the MAX_DUPLICATE_LOOKUPS budget —
 * capping before the self-exclusion would let a self-reference eat the budget
 * and push a real family member past the cap. Off-project and shape-invalid
 * entries are dropped BEFORE the budget too, so a list padded with foreign ids
 * cannot starve a real sibling out of it.
 *
 * `project` is REQUIRED. An absent or unusable one yields NO links at all, which
 * fails toward more candidates (each still capped by the run's `--cap`) — the
 * same safe direction MAX_FAMILY_MEMBERS takes, because over-collapsing silently
 * starves the queue while under-collapsing costs at most one run.
 */
export function declaredFamilyIds(shortId, duplicateOf, project) {
  const self = familyKey(shortId);
  const out = new Set();
  for (const raw of Array.isArray(duplicateOf) ? duplicateOf : []) {
    if (!isLocalFamilyId(raw, project)) continue;
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
 * `candidates`: `[{ shortId, duplicateOf, reconcile, eligible }]` — whatever
 * else the caller carries on each record is passed straight back untouched.
 * `eligible: false` marks a record the caller already ruled out: it joins the
 * union (so its `duplicate_of` edges survive) but is never grouped, selected or
 * deferred. Anything else, including an absent `eligible`, is a live candidate.
 * `options.handledShortIds`: SHORT-IDs of stubs that already carry a terminal
 * autofix marker (`sentry:fix-pr-opened` / `sentry:fix-refused`). Those stubs
 * are filtered out of the candidate window by the selector's own query, so
 * without this set a refused representative's four siblings would come back
 * one per run — the exact 5-runs-for-1-cause failure.
 * `options.handledEdges`: reverse-verified `[idA, idB]` family links the
 * forward `duplicate_of` graph misses (PR #1810 bug B) — each joins its two ids
 * into the union like a declared id, with both ends gated by isLocalFamilyId.
 * `options.project`: the Sentry project every family id must belong to (see
 * `isLocalFamilyId`). REQUIRED — absent, nothing joins and nothing blocks.
 *
 * Returns one decision per input candidate, IN INPUT ORDER:
 *   `{ candidate, selected, reason, representative, members }`
 * — `reason`/`representative` are null on a selected candidate; `members` is the
 * candidate's family member-id set (union-root members, sorted).
 */
export function collapseDuplicateFamilies(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const project = options.project;
  // Scoped the same way the joiners are: a blocker is a stub of THIS project by
  // construction (the caller's marker query filters on it), so an id that fails
  // the scope check is not a blocker either — one rule, both directions.
  const handled = new Set(
    [...(options.handledShortIds ?? [])]
      .filter((id) => isLocalFamilyId(id, project))
      .map(familyKey),
  );

  const uf = makeUnionFind();
  for (const candidate of list) {
    const key = familyKey(candidate.shortId);
    uf.add(key);
    for (const dup of declaredFamilyIds(
      candidate.shortId,
      candidate.duplicateOf,
      project,
    )) {
      uf.union(key, dup);
    }
  }

  // Reverse-verified edges (PR #1810 bug B). The selector's reverse
  // `in:comments` search finds family links the forward `duplicate_of` graph
  // cannot: a handled sibling whose verdict names a finalist, or a hub id two
  // stubs share through an issue that is not itself a candidate. Each admitted
  // edge is an authenticated `[idA, idB]` pair (the selector re-parses both
  // ends' verdicts before passing it here), and joins its two ids into the
  // union exactly as a declared id would. Both endpoints pass through
  // isLocalFamilyId, so a foreign-project id, the bare project slug, or a
  // shape-invalid token stays inert — the same over-collapse guard the declared
  // path applies, re-verified here against this new input.
  for (const edge of Array.isArray(options.handledEdges)
    ? options.handledEdges
    : []) {
    const [a, b] = Array.isArray(edge) ? edge : [];
    if (!isLocalFamilyId(a, project) || !isLocalFamilyId(b, project)) continue;
    const keyA = familyKey(a);
    const keyB = familyKey(b);
    uf.add(keyA);
    uf.add(keyB);
    uf.union(keyA, keyB);
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
    if (candidate.reconcile || candidate.eligible === false) continue;
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
    // Representative: the family's OLDEST candidate — its earliest input index,
    // because the caller passes the window oldest-first. Deliberately NOT a
    // ranking over the agent-authored graph: `createdAt` is the one ordering
    // untrusted text cannot set, and keeping the representative at the family's
    // earliest index is what preserves the caller's oldest-first cap (property 2
    // in this module's header).
    const representative = members[0];
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

  // An ineligible record contributed its edges above and stops there. Decide it
  // EXPLICITLY: the fallback below selects, so leaving it undecided would emit
  // exactly the candidate the caller ruled out. `reason` stays null — the reason
  // is the caller's (this module only owns family reasons), and it reports it.
  for (const candidate of list) {
    if (candidate.eligible === false) {
      decisions.set(candidate, {
        selected: false,
        reason: null,
        representative: null,
      });
    }
  }

  return list.map((candidate) => {
    const decision = decisions.get(candidate) ?? {
      selected: true,
      reason: null,
      representative: null,
    };
    // The family's full member-id set: union-root members, i.e. candidate ids
    // AND any declared/edge hub ids, including ones with no stub in the window.
    // The caller reverse-verifies a finalist by probing exactly these ids, so
    // the hub topology (a finalist and a handled sibling both declaring a
    // non-candidate C) is covered — probing C is what reaches the sibling.
    const members = [...uf.membersOf(familyKey(candidate.shortId))].sort();
    return { candidate, ...decision, members };
  });
}
