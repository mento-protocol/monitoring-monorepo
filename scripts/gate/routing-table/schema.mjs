/**
 * The routing table's schema, its closed verb set, and the normal form both
 * the table and the gate's live `case` arms are compared in.
 *
 * Validation runs at IMPORT and FAILS CLOSED. That direction is the whole
 * point: a malformed table must never produce a SMALLER command plan. The gate
 * exits non-zero and says what is wrong, rather than routing a subset of the
 * arms and printing "All mapped commands passed."
 *
 * Verbs are recorded under the gate's own bash function names rather than
 * invented camel-case aliases. A second naming layer is a second thing to keep
 * in step; with the live names, `routing-table.test.mjs` can assert every verb
 * the table uses is a function the gate actually defines.
 */

import { patternProblem } from "./pattern.mjs";

/**
 * Every effect verb the routing region may reach, with how many arguments each
 * takes.
 *
 * The set is CLOSED and holds exactly the verbs the routing region reaches
 * today — not every `add_*` helper the gate defines. An unknown verb fails at
 * import, which is what stops a typo becoming an arm that routes nothing, and
 * an unreachable verb listed "just in case" would weaken that to a spell check.
 * `routing-table.test.mjs` asserts every name here is a function the gate
 * actually defines, and that each arity matches the gate's own call sites.
 */
export const VERBS = Object.freeze({
  add_command: 2,
  add_preflight_command: 2,
  add_surface: 1,
  add_checklist: 2,
  add_adr_reminder: 1,
  add_turbo_package_task: 3,
  add_package_quality_commands: 2,
  add_package_vitest_typecheck_commands: 2,
  add_workspace_quality_commands: 1,
  add_dashboard_quality_commands: 1,
  add_aegis_quality_commands: 1,
  add_alerts_oncall_quality_commands: 1,
  add_root_tooling_package_script_checks: 1,
  add_terraform_validate_commands: 2,
  add_registered_terraform_validate_commands: 1,
  add_sentry_suite_gate_commands: 1,
  add_ui_react_doctor_diff: 1,
  add_ui_react_doctor_full_score: 1,
  add_ui_mutation_baseline: 1,
  add_ui_size_limit: 1,
  add_bridge_mutation_baseline: 1,
  add_indexer_mutation_baseline: 1,
  add_dashboard_codegen: 1,
  add_all_indexer_codegen: 1,
  add_indexer_mainnet_codegen: 1,
  add_indexer_testnet_codegen: 1,
  add_bridge_codegen_then_restore_mainnet: 1,
  add_reserve_yield_codegen_then_restore_mainnet: 1,
  route_lockfile_change: 0,
});

/** Ergonomic spellings of the five verbs that carry most of the table. */
const SUGAR = Object.freeze({
  command: { verb: "add_command", args: ["command", "reason"] },
  preflight: { verb: "add_preflight_command", args: ["preflight", "reason"] },
  surface: { verb: "add_surface", args: ["surface"] },
  checklist: { verb: "add_checklist", args: ["checklist", "reason"] },
  adrReminder: { verb: "add_adr_reminder", args: ["adrReminder"] },
});

/** The two globals the routing region mutates in place. */
export const SETTABLE = Object.freeze([
  "package_script_risk_changed",
  "root_package_json_class",
]);

/** The closed guard set. `pathEquals` carries a literal and is shaped, not listed. */
export const GUARDS = Object.freeze([
  "pathIsFile",
  "pathIsSymlink",
  "realTreeOnly",
  "nonEmpty",
]);

/** The `case` subjects an arm may dispatch on. */
export const SUBJECTS = Object.freeze(["path", "root_package_json_class"]);

/** Pattern sets the engine computes from the tree at run time. */
export const DYNAMIC_SOURCES = Object.freeze([
  "scriptsSymlinkTargets",
  "registeredTerraformStacks",
]);

/** How an arm declares what it did about ADR 0064's pairing rule. */
export const PAIRINGS = Object.freeze(["paired", "deliberately-unpaired"]);

/**
 * How long a reason has to be before it counts as one.
 *
 * Both escape hatches in this table — `pairing: "deliberately-unpaired"` and
 * `allowStale` — turn a check off for one arm, so each has to say what it is
 * accepting. A length floor is a crude test of substance and the only
 * mechanical one available; it is set where "n/a", "ok", "see above" and "not
 * needed" all fail and a sentence passes. Without it the opt-out is a word, and
 * the next reader cannot tell a considered exception from a silenced check.
 */
export const MIN_REASON = 30;

class TableError extends Error {
  constructor(where, message) {
    super(`${where}: ${message}`);
    this.name = "RoutingTableError";
  }
}

/**
 * Reduce one effect entry to its normal form — `{ kind, … }` with every field
 * the routing depends on and nothing else.
 *
 * `why` is deliberately dropped: prose is for the reader, and folding it into
 * the comparison would make the equality test red on a reworded comment while
 * saying nothing about routing.
 */
export function normalizeEffect(effect, where) {
  if (effect === null || typeof effect !== "object") {
    throw new TableError(where, "effect is not an object");
  }
  const keys = Object.keys(effect).filter((key) => key !== "why");

  if (Object.hasOwn(effect, "stop")) {
    expectExactly(keys, ["stop"], where);
    if (effect.stop !== true)
      throw new TableError(where, "`stop` must be true");
    return { kind: "break" };
  }

  if (Object.hasOwn(effect, "set")) {
    expectExactly(keys, ["set"], where);
    if (!SETTABLE.includes(effect.set)) {
      throw new TableError(where, `unknown assignment \`${effect.set}\``);
    }
    return { kind: "set", name: effect.set };
  }

  if (Object.hasOwn(effect, "when")) {
    expectExactly(keys, ["when", "effects"], where);
    return {
      kind: "when",
      guard: normalizeGuard(effect.when, where),
      effects: normalizeEffects(effect.effects, where),
    };
  }

  if (Object.hasOwn(effect, "dispatch")) {
    expectSubset(keys, ["dispatch", "arms", "trailingWhy"], where);
    if (!SUBJECTS.includes(effect.dispatch)) {
      throw new TableError(
        where,
        `unknown dispatch subject \`${effect.dispatch}\``,
      );
    }
    return {
      kind: "dispatch",
      subject: effect.dispatch,
      arms: normalizeArms(effect.arms, effect.dispatch, where),
    };
  }

  if (Object.hasOwn(effect, "verb")) {
    expectSubset(keys, ["verb", "args"], where);
    return normalizeCall(effect.verb, effect.args ?? [], where);
  }

  const sugar = Object.keys(SUGAR).find((key) => Object.hasOwn(effect, key));
  if (sugar === undefined) {
    throw new TableError(
      where,
      `effect has no recognised verb: ${keys.join(", ")}`,
    );
  }
  const shape = SUGAR[sugar];
  expectExactly(keys, shape.args, where);
  return normalizeCall(
    shape.verb,
    shape.args.map((field) => effect[field]),
    where,
  );
}

function normalizeCall(verb, args, where) {
  if (!Object.hasOwn(VERBS, verb)) {
    throw new TableError(where, `unknown effect verb \`${verb}\``);
  }
  if (!Array.isArray(args) || args.length !== VERBS[verb]) {
    throw new TableError(
      where,
      `\`${verb}\` takes ${VERBS[verb]} arguments, not ${Array.isArray(args) ? args.length : "a non-array"}`,
    );
  }
  for (const argument of args) {
    if (typeof argument !== "string" || argument === "") {
      throw new TableError(
        where,
        `\`${verb}\` has an empty or non-string argument`,
      );
    }
  }
  return { kind: "call", verb, args: [...args] };
}

function normalizeGuard(guard, where) {
  if (typeof guard === "string") {
    if (!GUARDS.includes(guard)) {
      throw new TableError(where, `unknown guard \`${guard}\``);
    }
    return guard;
  }
  if (
    guard !== null &&
    typeof guard === "object" &&
    Object.keys(guard).length === 1 &&
    typeof guard.pathEquals === "string" &&
    guard.pathEquals !== ""
  ) {
    return { pathEquals: guard.pathEquals };
  }
  throw new TableError(
    where,
    "guard is neither a known name nor `{ pathEquals }`",
  );
}

export function normalizeEffects(effects, where) {
  if (!Array.isArray(effects))
    throw new TableError(where, "`effects` is not an array");
  return effects.map((effect, index) =>
    normalizeEffect(effect, `${where} effect ${index}`),
  );
}

/**
 * A pattern that names an engine-computed value, e.g. a symlink target resolved
 * at run time. Only a `dynamic` group may hold one: the same text in a static
 * group is a placeholder nobody substitutes, so it would be matched as the
 * literal characters `${…}` and the arm would never fire.
 */
const DYNAMIC_PATTERN = /\$\{[a-z_][a-z_0-9]*\}/;

function normalizeArms(arms, subject, where, dynamic = null) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new TableError(where, "`arms` is missing or empty");
  }
  return arms.map((arm, index) => {
    const at = `${where} arm ${index}`;
    if (arm === null || typeof arm !== "object") {
      throw new TableError(at, "arm is not an object");
    }
    expectSubset(
      Object.keys(arm),
      ["patterns", "effects", "why", "pairing", "allowStale"],
      at,
    );
    if (!Array.isArray(arm.patterns) || arm.patterns.length === 0) {
      throw new TableError(at, "`patterns` is missing or empty");
    }
    if (subject === "path") {
      for (const pattern of arm.patterns) {
        if (DYNAMIC_PATTERN.test(pattern)) {
          if (dynamic === null) {
            throw new TableError(
              at,
              `pattern ${JSON.stringify(pattern)} names a run-time value, but this group is not \`dynamic\` — nothing would substitute it, so the arm would be matched as those literal characters and never fire`,
            );
          }
          continue;
        }
        const problem = patternProblem(pattern);
        if (problem !== null) {
          throw new TableError(
            at,
            `pattern ${JSON.stringify(pattern)} ${problem}`,
          );
        }
      }
    }
    if (arm.pairing !== undefined && !PAIRINGS.includes(arm.pairing)) {
      throw new TableError(
        at,
        `unknown \`pairing\` value ${JSON.stringify(arm.pairing)}`,
      );
    }
    if (
      arm.allowStale !== undefined &&
      (typeof arm.allowStale !== "string" ||
        arm.allowStale.trim().length < MIN_REASON)
    ) {
      throw new TableError(
        at,
        `\`allowStale\` must be the reason the path is allowed to be absent, as a string of at least ${MIN_REASON} characters — the opt-out turns the staleness check off for this arm, so it has to say what it is accepting`,
      );
    }
    return {
      patterns: [...arm.patterns],
      effects: normalizeEffects(arm.effects, at),
    };
  });
}

/**
 * Reduce the whole table to the form the equality test compares against the
 * gate's live arms, validating it on the way through.
 *
 * @param {readonly object[]} groups
 * @returns {object[]}
 */
export function normalizeGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TableError("routing table", "is missing or empty");
  }
  const seen = new Set();
  return groups.map((group, index) => {
    const where = `group ${index}`;
    if (group === null || typeof group !== "object") {
      throw new TableError(where, "group is not an object");
    }
    expectSubset(
      Object.keys(group),
      [
        "id",
        "why",
        "trailingWhy",
        "realTreeOnly",
        "dynamic",
        "requiresNonEmpty",
        "arms",
      ],
      where,
    );
    if (typeof group.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(group.id)) {
      throw new TableError(
        where,
        `\`id\` ${JSON.stringify(group.id)} is not a kebab-case name`,
      );
    }
    if (seen.has(group.id)) {
      throw new TableError(where, `duplicate group id \`${group.id}\``);
    }
    seen.add(group.id);
    if (
      group.dynamic !== undefined &&
      !DYNAMIC_SOURCES.includes(group.dynamic)
    ) {
      throw new TableError(
        where,
        `unknown dynamic source \`${group.dynamic}\``,
      );
    }
    return {
      id: group.id,
      realTreeOnly: group.realTreeOnly === true,
      dynamic: group.dynamic ?? null,
      requiresNonEmpty: group.requiresNonEmpty === true,
      arms: normalizeArms(
        group.arms,
        "path",
        `${where} (${group.id})`,
        group.dynamic ?? null,
      ),
    };
  });
}

/**
 * Every arm in the table, outermost first, with the group it belongs to, the
 * `case` subject it switches on, and whether its group is engine-computed.
 *
 * This walks the RAW table rather than the normal form, because the two lints
 * read `pairing` and `allowStale` — fields the normal form deliberately drops,
 * since neither says anything about where a path routes.
 */
export function walkArms(groups) {
  const found = [];
  const visit = (arms, context) => {
    for (const arm of arms) {
      found.push({ ...context, arm });
      for (const effect of arm.effects ?? []) visitEffect(effect, context);
    }
  };
  const visitEffect = (effect, context) => {
    if (Object.hasOwn(effect, "dispatch")) {
      visit(effect.arms, { ...context, subject: effect.dispatch });
    } else if (Object.hasOwn(effect, "when")) {
      for (const nested of effect.effects) visitEffect(nested, context);
    }
  };
  for (const group of groups) {
    visit(group.arms, {
      groupId: group.id,
      subject: "path",
      dynamic: group.dynamic ?? null,
    });
  }
  return found;
}

// There was a `literalPatterns(groups)` helper here that collapsed every
// literal pattern into one path-keyed Map. It is deliberately gone: keying by
// PATH rather than by ARM is what let a single `allowStale` switch the staleness
// check off for every other arm naming the same literal. `stalenessSubjects`
// walks arms directly so an exemption reaches only the arm that declares it.

function expectExactly(keys, wanted, where) {
  const missing = wanted.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !wanted.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new TableError(
      where,
      `expected exactly ${wanted.join(" + ")}${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}`,
    );
  }
}

function expectSubset(keys, allowed, where) {
  const extra = keys.filter((key) => !allowed.includes(key) && key !== "why");
  if (extra.length > 0) {
    throw new TableError(where, `unknown field(s) ${extra.join(", ")}`);
  }
}
