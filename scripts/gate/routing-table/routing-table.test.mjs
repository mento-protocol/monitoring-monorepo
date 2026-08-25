#!/usr/bin/env node
/**
 * The routing table's own checks: the schema, the group order, the closed verb
 * set, ADR 0064's pairing rule, and path staleness. The pins that keep the
 * table a trusted input to the gate — `implementation_signature()`, the Turbo
 * inputs, the table's own routing arm — are in `pins.test.mjs` beside it.
 *
 * Every check that CAN fail closed is proven to fail: each has a negative
 * control that builds a deliberately broken table and asserts the check reds on
 * it. A check nobody has seen red is a check nobody knows works — this repo has
 * the scar, in a test that printed "All 0 deploy scripts…" and exited 0.
 *
 * Run: pnpm gate:routing-table:test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  exemptedLiterals,
  pairingProblems,
  stalenessSubjects,
} from "./checks.mjs";
import { literalPatternPath } from "./pattern.mjs";
import { ROUTING_GROUPS, ROUTING_PLAN } from "./index.mjs";
import { VERBS, normalizeGroups, walkArms } from "./schema.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (relative) => readFileSync(`${REPO}${relative}`, "utf8");

/**
 * The group order, written out.
 *
 * Group order is routing: the plan is built in group order and `add_command`
 * keeps the FIRST reason it is given for a command, which
 * `production-infra-identity-contract/routing.test.mjs` asserts on. The table
 * is assembled by concatenating eleven data modules, and a split that silently
 * reorders is exactly what this list exists to catch — so it is spelled out
 * here rather than derived from the same imports it is checking.
 */
const GROUP_ORDER = [
  "documentation-surface",
  "documentation-contracts",
  "upstash-mcp-transport",
  "manifests-and-package-manager",
  "shell-syntax",
  "babysit-repo-hook",
  "vitest-configuration",
  "tree",
  "terraform-root",
  "sentry-ci-coverage",
  "sentry-suite-gate",
  "scripts-symlink",
  "scripts-symlink-target",
  "registered-terraform-stacks",
];

test("the groups are in the order the gate applies them", () => {
  assert.deepEqual(
    ROUTING_PLAN.map((group) => group.id),
    GROUP_ORDER,
    "the assembled group order changed. Arm order and group order are both routing, " +
      "so this list moves only when the routing was meant to.",
  );
});

test("the table is frozen all the way down", () => {
  // Not just the outer array: an importer that could push a command onto an arm
  // could change what the gate schedules with no diff to review.
  const frozen = (value) =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen));
  assert.ok(frozen(ROUTING_GROUPS), "ROUTING_GROUPS is not deeply frozen");
  assert.ok(frozen(ROUTING_PLAN), "ROUTING_PLAN is not deeply frozen");
});

test("the schema refuses a run-time placeholder in a static group", () => {
  assert.throws(
    () =>
      normalizeGroups(table({ id: "x", arms: [arm(["${some_target}/*"])] })),
    /names a run-time value/,
  );
  assert.doesNotThrow(() =>
    normalizeGroups(
      table({
        id: "x",
        dynamic: "scriptsSymlinkTargets",
        arms: [arm(["${scripts_symlink_target}/*"])],
      }),
    ),
  );
});

test("a dynamic group may hold only the exact pattern its source emits", () => {
  // A placeholder pattern cannot go through `patternProblem` — the text that
  // replaces `${…}` is not known until run time — so an earlier version of this
  // check skipped validation entirely for anything containing one. The allowed
  // forms are enumerated instead, and everything else is refused rather than
  // waved through unvalidated.
  const refused = [
    "${some_target}/*", // right shape, wrong variable
    "${scripts_symlink_target}/[[:alpha:]]*", // malformed remainder
    "${scripts_symlink_target}/*.mjs", // narrower than the engine emits
    "${terraform_stack_path}/*", // the OTHER source's form
  ];
  for (const pattern of refused) {
    assert.throws(
      () =>
        normalizeGroups(
          table({
            id: "x",
            dynamic: "scriptsSymlinkTargets",
            arms: [arm([pattern])],
          }),
        ),
      /is not the form/,
      `${pattern} was accepted for scriptsSymlinkTargets`,
    );
  }
});

/**
 * Verb name → the number of `args[…]` slots the engine's dispatch reads for it.
 *
 * Read out of `scripts/gate/mapping/route.mjs`'s source rather than imported:
 * the map is module-private, and arity is a property of the implementation text
 * rather than of the value.
 */
const ROUTE_VERB_ARITIES = (() => {
  const source = read("/scripts/gate/mapping/route.mjs");
  const open = source.indexOf("\nconst VERBS = {");
  const close = source.indexOf("\n};", open);
  assert.ok(
    open !== -1 && close !== -1,
    "scripts/gate/mapping/route.mjs no longer declares a `const VERBS = { … };` object; this pin cannot read it",
  );
  // Each entry starts at column 2 with `<name>:`; its implementation runs to
  // the next entry. Arity is the highest `args[N]` slot that span reads, so a
  // verb reading none — `route_lockfile_change` — measures 0.
  const body = source.slice(open, close);
  const starts = [...body.matchAll(/\n {2}([a-z_][a-z0-9_]*):/g)];
  const measured = new Map();
  for (const [index, at] of starts.entries()) {
    const span = body.slice(
      at.index + at[0].length,
      starts[index + 1]?.index ?? body.length,
    );
    const slots = [...span.matchAll(/\bargs\[(\d+)\]/g)].map((m) => +m[1]);
    measured.set(at[1], slots.length === 0 ? 0 : Math.max(...slots) + 1);
  }
  // Controls: a parse that found nothing would report perfect agreement.
  assert.equal(measured.get("add_command"), 2, "the verb reader is broken");
  assert.equal(
    measured.get("add_turbo_package_task"),
    3,
    "the verb reader cannot measure a three-argument verb",
  );
  return measured;
})();

test("the engine implements the closed verb set, at the recorded arity", () => {
  // Before D5c this was checked against the gate's own bash `add_*` functions.
  // The arms are gone; `route.mjs` is where a verb name becomes a call now, and
  // every direction here fails somewhere worse if it is not checked: a name the
  // engine does not implement throws on the change set that first reaches that
  // arm, on somebody's pre-push; an implementation the schema does not record is
  // unreachable and reads as live routing; and a wrong arity is caught nowhere
  // at import, because the schema validates only the COUNT the table supplies.
  assert.deepEqual(
    Object.keys(VERBS).filter((verb) => !ROUTE_VERB_ARITIES.has(verb)),
    [],
    "the table's closed verb set holds names scripts/gate/mapping/route.mjs does not implement",
  );
  assert.deepEqual(
    [...ROUTE_VERB_ARITIES.keys()].filter(
      (verb) => !Object.hasOwn(VERBS, verb),
    ),
    [],
    "scripts/gate/mapping/route.mjs implements verbs the table's closed set does not record",
  );
  for (const [verb, arity] of ROUTE_VERB_ARITIES) {
    assert.equal(
      arity,
      VERBS[verb],
      `scripts/gate/mapping/route.mjs reads ${arity} argument(s) for \`${verb}\`; the table records ${VERBS[verb]}`,
    );
  }

  // And no name in the set is unreachable from the table: a closed set that
  // admits names nothing routes is a spell check.
  const reached = new Set();
  const visit = (effects) => {
    for (const effect of effects) {
      if (effect.kind === "call") reached.add(effect.verb);
      if (effect.kind === "when") visit(effect.effects);
      for (const nested of effect.arms ?? []) visit(nested.effects);
    }
  };
  for (const group of ROUTING_PLAN) {
    for (const arm of group.arms) visit(arm.effects);
  }
  assert.ok(reached.size > 0, "the table walked to zero verbs");
  assert.deepEqual(
    Object.keys(VERBS).filter((verb) => !reached.has(verb)),
    [],
    "the verb set holds a verb no arm in the table reaches",
  );
});

test("no literal path the table names has gone stale", () => {
  const missing = stalenessSubjects(ROUTING_GROUPS)
    .filter((subject) => !existsSync(`${REPO}/${subject.path}`))
    .map(
      (subject) =>
        `group \`${subject.groupId}\` names ${JSON.stringify(subject.path)} as a ${subject.kind}` +
        (subject.command === undefined ? "" : ` in \`${subject.command}\``),
    );
  assert.deepEqual(
    missing,
    [],
    "the routing table names paths that are not in the tree:\n  - " +
      missing.join("\n  - ") +
      "\n\nA stale pattern is invisible in bash — the arm simply never matches again and no check reds. " +
      'Repoint it, or set `allowStale: "<reason>"` on the arm if the path is deliberately not here yet.',
  );
});

test("every allowStale exemption is still doing something", () => {
  // Per ENTRY, not per arm. `allowStale` is a map from pattern to reason, so
  // the retirement question is asked of each exempted path on its own: one path
  // that has since appeared makes THAT entry dead even while its siblings are
  // still absent. Guarding on the obsolete string form here would have skipped
  // the live exemption entirely and never retired anything.
  let checked = 0;
  for (const { groupId, arm } of walkArms(ROUTING_GROUPS)) {
    if (arm.allowStale === undefined) continue;
    const exempted = exemptedLiterals(arm);
    assert.ok(
      exempted.length > 0,
      `group \`${groupId}\`, arm [${arm.patterns.join(" | ")}]: carries \`allowStale\` but exempts nothing`,
    );
    for (const pattern of exempted) {
      checked += 1;
      // The PATH the pattern names, for the same reason the staleness check
      // resolves it: an escaped literal names a file with no backslashes in it.
      assert.ok(
        !existsSync(`${REPO}/${literalPatternPath(pattern)}`),
        `group \`${groupId}\`: \`allowStale\` still exempts ${JSON.stringify(pattern)}, which now exists — that entry is dead and should go`,
      );
    }
  }
  assert.ok(
    checked > 0,
    "no allowStale entry was checked at all; the retirement check is reading a shape the table no longer uses",
  );
});

test("the live table breaks no pairing rule", () => {
  assert.deepEqual(pairingProblems(ROUTING_GROUPS), []);
});

// --- negative controls -----------------------------------------------------
//
// Each builds the smallest broken table that trips one check and asserts it
// reds. Without these the checks above are assertions about a table that
// happens to be clean.

const arm = (patterns, effects = [{ surface: "docs" }]) => ({
  patterns,
  effects,
});
const table = (...groups) => groups;

test("the pairing lint reds on an unpaired literal-prefix glob", () => {
  const problems = pairingProblems(
    table({ id: "x", arms: [arm(["scripts/widget-*.mjs"])] }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /scripts\/\*\/widget-\*\.mjs/);
});

test("the pairing lint reds when the opt-out carries no reason", () => {
  // The opt-out must cost something. A bare flag would suppress the rule this
  // table exists to enforce with one word and no argument.
  for (const why of [undefined, "", "   ", "n/a", "not needed"]) {
    const problems = pairingProblems(
      table({
        id: "x",
        arms: [
          {
            patterns: ["scripts/widget-*.mjs"],
            pairing: "deliberately-unpaired",
            ...(why === undefined ? {} : { why }),
            effects: [{ surface: "docs" }],
          },
        ],
      }),
    );
    assert.equal(
      problems.length,
      1,
      `\`why: ${JSON.stringify(why)}\` was accepted`,
    );
    assert.match(problems[0], /without a `why`/);
  }
});

test("the pairing lint accepts an unpaired glob that says it is deliberate", () => {
  assert.deepEqual(
    pairingProblems(
      table({
        id: "x",
        arms: [
          {
            ...arm(["scripts/widget-*.mjs"]),
            pairing: "deliberately-unpaired",
            why: "the widget lives at the top of scripts/ by contract",
          },
        ],
      }),
    ),
    [],
  );
});

test("the pairing lint reds when a declared pair loses its sibling", () => {
  const problems = pairingProblems(
    table({
      id: "x",
      arms: [{ ...arm(["scripts/deploy/thing.sh"]), pairing: "paired" }],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /holds no `scripts\/\*\/…` sibling/);
});

test("the pairing lint reds when a real pair forgets to declare itself", () => {
  const problems = pairingProblems(
    table({
      id: "x",
      arms: [arm(["scripts/deploy/thing.sh", "scripts/*/thing.sh"])],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not declare/);
});

test("the staleness check reds on a path that is not in the tree", () => {
  const subjects = stalenessSubjects(
    table({ id: "x", arms: [arm(["scripts/this-file-does-not-exist.mjs"])] }),
  );
  assert.deepEqual(
    subjects
      .filter((subject) => !existsSync(`${REPO}/${subject.path}`))
      .map((s) => s.path),
    ["scripts/this-file-does-not-exist.mjs"],
  );
});

test("a templated command still has its static paths checked", () => {
  // Only the `{path}` token is exempt — it is the changed path, which exists by
  // construction. The command carrying it can still name a static module, and
  // that module's staleness matters exactly as much as any other arm's.
  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [
        arm(
          ["docs/x.md"],
          [
            {
              command: "node scripts/gone/checker.mjs --file {path}",
              reason: "r",
            },
            { command: "bash -n {path}", reason: "r" },
          ],
        ),
      ],
    }),
  );
  assert.deepEqual(
    subjects.filter((subject) => subject.kind === "command").map((s) => s.path),
    ["scripts/gone/checker.mjs"],
    "the static path in a templated command was skipped with the token",
  );
});

test("the staleness check reds on a checklist that is not in the tree", () => {
  // The quietest of the three subject kinds: a checklist path is only ever
  // printed as a reminder, so a renamed one fails nowhere at all.
  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [
        arm(
          ["docs/x.md"],
          [{ checklist: "docs/pr-checklists/gone.md", reason: "r" }],
        ),
      ],
    }),
  );
  assert.deepEqual(
    subjects
      .filter((subject) => subject.kind === "checklist")
      .map((s) => s.path),
    ["docs/pr-checklists/gone.md"],
  );
});

test("the staleness check reds on a pathEquals guard that is not in the tree", () => {
  // A guard literal fails as quietly as a stale arm pattern: the commands it
  // guards simply stop being scheduled.
  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [
        arm(
          ["docs/x.md"],
          [
            {
              when: { pathEquals: "alerts/infra/gone/pnpm-workspace.yaml" },
              effects: [{ surface: "docs" }],
            },
          ],
        ),
      ],
    }),
  );
  assert.deepEqual(
    subjects.filter((subject) => subject.kind === "guard").map((s) => s.path),
    ["alerts/infra/gone/pnpm-workspace.yaml"],
  );
});

test("an allowStale exemption reaches only the arm that declares it", () => {
  // The exemption is per ARM, not per path. One arm accepting that a path is
  // not here yet says nothing about another arm that names it and needs it — and
  // a table-wide exemption set would switch the check off everywhere the path
  // appears, which is the fail-open shape this table exists to remove.
  const subjects = stalenessSubjects(
    table(
      {
        id: "exempting",
        arms: [
          {
            ...arm(["scripts/not-here-yet.mjs"]),
            allowStale: {
              "scripts/not-here-yet.mjs":
                "a config file this repository does not carry today, routed so adding one is covered",
            },
          },
        ],
      },
      { id: "needing", arms: [arm(["scripts/not-here-yet.mjs"])] },
    ),
  );
  assert.deepEqual(
    subjects
      .filter((subject) => subject.path === "scripts/not-here-yet.mjs")
      .map((subject) => subject.groupId),
    ["needing"],
    "the exemption leaked out of the arm that declared it",
  );
});

test("both lints refuse a normalized table instead of reporting it clean", () => {
  // `pairing`, `allowStale` and `why` do not survive `normalizeGroups`, so a
  // normalized table would produce no violations and read as clean. A lint that
  // reports clean because it was handed the wrong shape is a green light nobody
  // has reason to doubt, so the shape is checked rather than documented.
  for (const check of [pairingProblems, stalenessSubjects]) {
    assert.throws(
      () => check(ROUTING_PLAN),
      /NORMALIZED routing groups/,
      `${check.name} accepted ROUTING_PLAN`,
    );
  }
  // And it must still accept the real thing.
  assert.deepEqual(pairingProblems(ROUTING_GROUPS), []);
  assert.ok(stalenessSubjects(ROUTING_GROUPS).length > 400);
});

test("both lints refuse a table with nothing in it to check", () => {
  for (const check of [pairingProblems, stalenessSubjects]) {
    assert.throws(() => check([]), /no routing groups/);
    assert.throws(
      () => check([{ id: "x", arms: [{ patterns: ["a"], effects: [] }] }]),
      /no effects at all/,
    );
  }
});

test("both lints refuse a malformed table instead of walking past the bad part", () => {
  // `walkArms` silently skips anything that is not the shape it expects, so
  // every one of these would otherwise be walked past and the lint would report
  // clean over the part it did read. The schema makes them unreachable for the
  // real table; the lints are exported and callable with anything.
  const malformed = [
    [
      "a primitive where an effect belongs",
      [{ id: "x", arms: [{ patterns: ["a"], effects: ["call"] }] }],
      /where an effect object belongs/,
    ],
    [
      "null where an effect belongs",
      [{ id: "x", arms: [{ patterns: ["a"], effects: [null] }] }],
      /where an effect object belongs/,
    ],
    [
      "an arm with no effects array, beside a sibling that has one",
      [
        {
          id: "x",
          arms: [
            { patterns: ["a"], effects: [{ surface: "docs" }] },
            { patterns: ["b"] },
          ],
        },
      ],
      /`effects` that is not an array/,
    ],
    [
      "an arm with no patterns",
      [{ id: "x", arms: [{ effects: [{ surface: "docs" }] }] }],
      /no `patterns`/,
    ],
    [
      "a group whose arms are not an array",
      [{ id: "x", arms: "everything" }],
      /`arms` that is not a non-empty array/,
    ],
    [
      "a nested dispatch whose arms are empty",
      [
        {
          id: "x",
          arms: [
            {
              patterns: ["a"],
              effects: [{ dispatch: "path", arms: [] }],
            },
          ],
        },
      ],
      /`arms` that is not a non-empty array/,
    ],
  ];
  for (const check of [pairingProblems, stalenessSubjects]) {
    for (const [name, groups, expected] of malformed) {
      assert.throws(
        () => check(groups),
        expected,
        `${check.name} accepted ${name}`,
      );
    }
  }
});

test("an allowStale exemption reaches only the pattern it names", () => {
  // Per PATTERN, not per arm. The live arm exempts three absent pnpm config
  // files together; an arm-wide flag would have covered a fourth absent path
  // dropped in later without anyone deciding it should.
  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [
        {
          patterns: ["scripts/absent-a.mjs", "scripts/absent-b.mjs"],
          allowStale: {
            "scripts/absent-a.mjs":
              "deliberately not in the tree yet; the arm routes it for the commit that adds it",
          },
          effects: [{ surface: "docs" }],
        },
      ],
    }),
  );
  assert.deepEqual(
    subjects.filter((s) => s.kind === "pattern").map((s) => s.path),
    ["scripts/absent-b.mjs"],
    "the exemption covered a sibling pattern it does not name",
  );
});

test("the schema refuses an allowStale that names a pattern its arm does not", () => {
  assert.throws(
    () =>
      normalizeGroups(
        table({
          id: "x",
          arms: [
            {
              ...arm(["scripts/a.mjs"]),
              allowStale: {
                "scripts/somewhere-else.mjs":
                  "a reason of entirely adequate length to pass the floor",
              },
            },
          ],
        }),
      ),
    /which this arm does not name/,
  );
  for (const shape of ["a string reason of adequate length here", [], {}]) {
    assert.throws(
      () =>
        normalizeGroups(
          table({
            id: "x",
            arms: [{ ...arm(["scripts/a.mjs"]), allowStale: shape }],
          }),
        ),
      /non-empty map/,
      `allowStale accepted ${JSON.stringify(shape)}`,
    );
  }
});

test("a literal pattern is checked as the path it names, not as its pattern text", () => {
  // `app/\[id\]/page.tsx` is how a Next.js dynamic-route directory has to be
  // written so its brackets are not read as a character class. It is a literal,
  // and the file it names has no backslashes in its name — asking the
  // filesystem about the pattern text would report the arm stale forever.
  assert.equal(
    literalPatternPath("ui-dashboard/src/app/pool/\\[poolId\\]/page.tsx"),
    "ui-dashboard/src/app/pool/[poolId]/page.tsx",
  );
  assert.equal(literalPatternPath("scripts/foo\\*.mjs"), "scripts/foo*.mjs");
  assert.equal(literalPatternPath("scripts/plain.mjs"), "scripts/plain.mjs");

  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [arm(["ui-dashboard/src/app/pool/\\[poolId\\]/page.tsx"])],
    }),
  );
  const [subject] = subjects.filter((s) => s.kind === "pattern");
  assert.equal(subject.path, "ui-dashboard/src/app/pool/[poolId]/page.tsx");
  assert.ok(
    existsSync(`${REPO}/${subject.path}`),
    "the escaped-bracket path this test uses is no longer in the tree; pick another real one",
  );
});

test("an allowStale arm with only globs exempts nothing", () => {
  assert.deepEqual(
    exemptedLiterals({
      patterns: ["*/.npmrc", "scripts/*.mjs"],
      allowStale: "a reason long enough to be a real one",
    }),
    [],
  );
});

test("the staleness check reads paths out of scheduled commands too", () => {
  const subjects = stalenessSubjects(
    table({
      id: "x",
      arms: [
        arm(
          ["docs/x.md"],
          [{ command: "node scripts/gone/missing.test.mjs", reason: "r" }],
        ),
      ],
    }),
  );
  assert.deepEqual(
    subjects.filter((subject) => subject.kind === "command").map((s) => s.path),
    ["scripts/gone/missing.test.mjs"],
  );
});

test("the schema refuses an unknown verb", () => {
  assert.throws(
    () =>
      normalizeGroups(
        table({ id: "x", arms: [arm(["a"], [{ verb: "add_nothing" }])] }),
      ),
    /unknown effect verb/,
  );
});

test("the schema refuses a duplicate group id", () => {
  assert.throws(
    () =>
      normalizeGroups(
        table({ id: "x", arms: [arm(["a"])] }, { id: "x", arms: [arm(["b"])] }),
      ),
    /duplicate group id/,
  );
});

test("the schema refuses a malformed pattern", () => {
  assert.throws(
    () => normalizeGroups(table({ id: "x", arms: [arm(["a|b"])] })),
    /separates arms/,
  );
  assert.throws(
    () => normalizeGroups(table({ id: "x", arms: [arm([""])] })),
    /is empty/,
  );
});

test("the schema refuses the wrong number of arguments", () => {
  assert.throws(
    () =>
      normalizeGroups(
        table({
          id: "x",
          arms: [arm(["a"], [{ verb: "add_command", args: ["one"] }])],
        }),
      ),
    /takes 2 arguments/,
  );
});

test("the schema refuses an allowStale opt-out with no real reason", () => {
  for (const reason of ["", "n/a", "not needed", 7]) {
    assert.throws(
      () =>
        normalizeGroups(
          table({
            id: "x",
            arms: [{ ...arm(["scripts/gone.mjs"]), allowStale: reason }],
          }),
        ),
      /allowStale/,
      `\`allowStale: ${JSON.stringify(reason)}\` was accepted`,
    );
  }
});

test("the schema refuses a non-boolean group flag", () => {
  // `=== true` normalizes any non-boolean to FALSE, so `"true"` copied out of a
  // JSON snippet would silently un-fence a repository-specific group from the
  // gate's stub fixture repositories — fail-open, in the direction that widens
  // routing.
  for (const flag of ["realTreeOnly", "requiresNonEmpty"]) {
    for (const value of ["true", "false", 1, 0, null]) {
      assert.throws(
        () =>
          normalizeGroups(
            table({ id: "x", [flag]: value, arms: [arm(["a"])] }),
          ),
        /is not a boolean/,
        `${flag}: ${JSON.stringify(value)} was accepted`,
      );
    }
    assert.doesNotThrow(() =>
      normalizeGroups(table({ id: "x", [flag]: true, arms: [arm(["a"])] })),
    );
    assert.doesNotThrow(() =>
      normalizeGroups(table({ id: "x", [flag]: false, arms: [arm(["a"])] })),
    );
  }
});

test("a fixed pattern in a dynamic group is still checked for staleness", () => {
  // Only the PLACEHOLDER cannot be resolved before substitution. Skipping the
  // whole dynamic group exempted any fixed pattern sharing an arm with one,
  // which is a property of where the pattern sits rather than of what it is.
  const subjects = stalenessSubjects(
    table({
      id: "x",
      dynamic: "scriptsSymlinkTargets",
      arms: [arm(["${scripts_symlink_target}/*", "scripts/gone/fixed.mjs"])],
    }),
  );
  assert.deepEqual(
    subjects.filter((s) => s.kind === "pattern").map((s) => s.path),
    ["scripts/gone/fixed.mjs"],
    "a fixed pattern beside a placeholder was skipped with the group",
  );
});

test("the schema refuses a noncanonical path segment", () => {
  // `scripts/../package.json` is a real file to `existsSync`, so the staleness
  // check would pass it — while the gate compares the changed path as a literal
  // string and git never emits that spelling, so the arm can never fire. The
  // two checks would disagree in the one direction that reads as healthy: a
  // pattern that looks verified and routes nothing.
  for (const pattern of [
    "scripts/../package.json",
    "./package.json",
    "scripts/./gate/index.mjs",
    "scripts//gate/index.mjs",
    "..",
  ]) {
    assert.throws(
      () => normalizeGroups(table({ id: "x", arms: [arm([pattern])] })),
      /`\.` or `\.\.` segment|empty path segment/,
      `${pattern} was accepted`,
    );
  }
  // A dot INSIDE a segment is ordinary and must still be accepted.
  assert.doesNotThrow(() =>
    normalizeGroups(
      table({ id: "x", arms: [arm([".npmrc", "scripts/a.test.mjs", "a..b"])] }),
    ),
  );
});

test("the schema refuses an unknown guard and an unknown field", () => {
  assert.throws(
    () =>
      normalizeGroups(
        table({
          id: "x",
          arms: [arm(["a"], [{ when: "pathIsPurple", effects: [] }])],
        }),
      ),
    /unknown guard/,
  );
  assert.throws(
    () =>
      normalizeGroups(
        table({ id: "x", arms: [{ ...arm(["a"]), colour: "red" }] }),
      ),
    /unknown field/,
  );
});
