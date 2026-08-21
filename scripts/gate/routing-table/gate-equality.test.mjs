#!/usr/bin/env node
/**
 * The transitional check: the routing table and the gate's live `case` arms
 * describe the SAME routing.
 *
 * While both exist, the table is a second copy of a routing authority, and a
 * second copy nobody compares is a copy that drifts. This test is what lets the
 * bash arms be retired later without re-deriving what they said — and, until
 * then, what stops the table and the gate disagreeing in silence.
 *
 * It compares the normal form, not the text: patterns, verbs, arguments,
 * guards, and order. Comments are dropped on both sides, because rewording a
 * comment is not a routing change.
 *
 * Run: node --test scripts/gate/routing-table/
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { gateRoutingPlan } from "./gate-arms.mjs";
import { ROUTING_PLAN } from "./index.mjs";

const GATE = fileURLToPath(
  new URL("../../agent-quality-gate.sh", import.meta.url),
);

const gatePlan = gateRoutingPlan(readFileSync(GATE, "utf8"));

/**
 * Report the FIRST difference with the group and arm it belongs to.
 *
 * A bare `deepStrictEqual` over thirteen groups prints a diff nobody can read,
 * and an unreadable failure is one somebody re-runs rather than reads. The
 * whole value of this check is that it names the arm.
 */
function difference(table, gate, path) {
  if (Array.isArray(table) || Array.isArray(gate)) {
    if (!Array.isArray(table) || !Array.isArray(gate)) {
      return `${path}: one side is a list and the other is not`;
    }
    if (table.length !== gate.length) {
      return `${path}: the table has ${table.length} entries, the gate has ${gate.length}`;
    }
    for (let index = 0; index < table.length; index += 1) {
      const found = difference(table[index], gate[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (
    table !== null &&
    gate !== null &&
    typeof table === "object" &&
    typeof gate === "object"
  ) {
    const keys = [
      ...new Set([...Object.keys(table), ...Object.keys(gate)]),
    ].sort();
    // Name an arm by the patterns it matches, not only by its index. An index
    // path sends a reader counting arms in two files; the pattern list is the
    // thing they can search for in both.
    const named = Array.isArray(table.patterns)
      ? `${path} [${table.patterns.join(" | ")}]`
      : path;
    for (const key of keys) {
      const found = difference(table[key], gate[key], `${named}.${key}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (table === gate) return null;
  return `${path}: the table has ${JSON.stringify(table)}, the gate has ${JSON.stringify(gate)}`;
}

/** A human name for a group, so a failure says `tree` rather than `[6]`. */
const label = (index) => `group ${index} (${ROUTING_PLAN[index]?.id ?? "?"})`;

test("the table and the gate hold the same number of routing groups", () => {
  assert.equal(
    ROUTING_PLAN.length,
    gatePlan.length,
    `the table has ${ROUTING_PLAN.length} groups and the gate has ${gatePlan.length}. ` +
      "Group order is routing: the plan is built in group order and `add_command` keeps the first reason it is given.",
  );
});

test("every group routes identically in the table and in the gate", () => {
  for (let index = 0; index < ROUTING_PLAN.length; index += 1) {
    // The gate's `case` statements have no names, so the table's group id is
    // the one field with no counterpart to compare against.
    const { id: _id, ...table } = ROUTING_PLAN[index];
    const found = difference(table, gatePlan[index], label(index));
    assert.equal(
      found,
      null,
      `${found}\n\nThe routing table and \`scripts/agent-quality-gate.sh\` disagree. ` +
        "One of them was edited without the other. Until the bash arms are retired the gate is the one that runs, " +
        "so a table-only change is a table that lies and a gate-only change is a table that has gone stale.",
    );
  }
});

test("every arm the gate reaches is reachable in the table too", () => {
  const armCount = (groups) =>
    groups.reduce((total, group) => total + countArms(group.arms), 0);
  assert.equal(
    armCount(ROUTING_PLAN),
    armCount(gatePlan),
    "the table and the gate hold different arm counts, so one of them routes a path the other does not",
  );
});

function countArms(arms) {
  let total = arms.length;
  for (const arm of arms) {
    for (const effect of arm.effects) total += countEffectArms(effect);
  }
  return total;
}

function countEffectArms(effect) {
  if (effect.kind === "dispatch") return countArms(effect.arms);
  if (effect.kind === "when") {
    return effect.effects.reduce(
      (total, nested) => total + countEffectArms(nested),
      0,
    );
  }
  return 0;
}
