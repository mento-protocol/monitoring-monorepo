/**
 * The quality gate's routing table, as data.
 *
 * WHAT THIS IS
 *
 * `scripts/agent-quality-gate.sh` decides which checks a change has to run by
 * walking every changed path through thirteen independent first-match `case`
 * statements. That is a table written as control flow, and three properties the
 * tree depends on are enforced by review alone once it is written that way:
 * paired any-depth arms, first-arm-wins ordering, and literal freshness. This
 * module holds the same routing as an ordered, frozen ES-module tree so those
 * three become checks instead of habits. ADR 0069 records the decision.
 *
 * WHAT DEPENDS ON THE ORDER
 *
 * Two orders, and both are routing:
 *
 *   - GROUP order. Every group runs for every path, so groups do not shadow one
 *     another — but the plan is built in group order and `add_command` keeps the
 *     FIRST reason it is given for a command. Reorder groups and reason strings
 *     move, which `production-infra-identity-contract/routing.test.mjs` asserts
 *     on.
 *   - ARM order within a group. First match wins and no later arm in that group
 *     runs. A new arm for `scripts/<dir>/deploy-*.sh` must sit ABOVE the widened
 *     `scripts/deploy-*.sh` pair or it never runs at all.
 *
 * So this file concatenates its parts in an explicit sequence, and
 * `routing-table.test.mjs` asserts the resulting group ids against a written-out
 * list. A module split that silently reorders is the thing that check exists to
 * catch.
 *
 * WHY IT IS SPLIT AT ALL
 *
 * The table with the reasoning its arms carry is ~3,700 formatted lines. The
 * repo's file-size watchlist hard-caps a `scripts/` module at 1,000 lines and
 * reports one at 600, so a single-file table would land as an actionable row in
 * the month it shipped. The parts are cut on family boundaries; size decides how
 * many cuts, never where they fall.
 *
 * WHAT VALIDATES IT
 *
 * Import-time, and FAILING CLOSED: the schema (unknown verb, duplicate group
 * id, malformed pattern, bad guard, wrong argument count) and ADR 0064's
 * pairing rule. The direction matters — a malformed table must never produce a
 * SMALLER command plan, because a smaller plan is a gate that passes while
 * running fewer checks. The staleness check and the bash-oracle pattern proof
 * live in the test suite, because both need the tree and the gate runs against
 * fixture repositories that have neither.
 *
 * WHAT PINS IT
 *
 * `implementation_signature()` in the gate lists every module in this directory.
 * An entry it cannot `stat` hashes as `__missing__`, which FREEZES the
 * signature, so `--skip-if-fresh` reuses a stale stamp and skips real diagnostic
 * work. Adding a module here without adding it there is the one mistake in this
 * directory that fails silently. `scripts/AGENTS.md` records the pin.
 */

import { pairingProblems } from "./checks.mjs";
import { normalizeGroups } from "./schema.mjs";
import { HEAD_GROUPS } from "./groups-head.mjs";
import { PACKAGE_ARMS } from "./arms-packages.mjs";
import { SERVICE_ARMS } from "./arms-services.mjs";
import { WORKFLOW_ARMS } from "./arms-workflows.mjs";
import { ALERT_ARMS } from "./arms-alerts.mjs";
import { SCRIPT_ARMS } from "./arms-scripts.mjs";
import { SCRIPT_MODULE_ARMS } from "./arms-script-modules.mjs";
import { WORKSPACE_ARMS, TAIL_GROUPS } from "./groups-tail.mjs";

/**
 * The gate's largest `case` — every arm that keys off a top-level directory in
 * the tree. Its arms are held in seven modules purely for size; the sequence
 * below IS the arm order, and it must not be sorted, deduplicated, or
 * rearranged for tidiness.
 */
const TREE_GROUP = {
  id: "tree",
  arms: [
    ...PACKAGE_ARMS,
    ...SERVICE_ARMS,
    ...WORKFLOW_ARMS,
    ...ALERT_ARMS,
    ...SCRIPT_ARMS,
    ...SCRIPT_MODULE_ARMS,
    ...WORKSPACE_ARMS,
  ],
};

/**
 * Freeze the whole tree, not just the outer array.
 *
 * A shallow freeze protects the group list and leaves every arm and every
 * effect writable, which is the opposite of what a routing authority wants: an
 * importer could push a command onto an arm and the table would carry it with
 * no diff to review.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/** The whole routing table, in the order the gate applies it. */
export const ROUTING_GROUPS = deepFreeze([
  ...HEAD_GROUPS,
  TREE_GROUP,
  ...TAIL_GROUPS,
]);

/**
 * The table reduced to what routing depends on: patterns, verbs, arguments,
 * guards and order. `normalizeGroups` drops `why`, `pairing` and `allowStale` —
 * a reviewer reads those, routing does not. `scripts/gate/mapping/route.mjs`
 * walks these groups; `routing-table.test.mjs` pins their order and verbs.
 */
export const ROUTING_PLAN = deepFreeze(normalizeGroups(ROUTING_GROUPS));

const problems = pairingProblems(ROUTING_GROUPS);
if (problems.length > 0) {
  throw new Error(
    `the gate routing table breaks ADR 0064's pairing rule:\n  - ${problems.join("\n  - ")}`,
  );
}
