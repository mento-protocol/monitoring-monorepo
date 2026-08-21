#!/usr/bin/env node
/**
 * The routing table's own checks: the schema, the group order, the closed verb
 * set, ADR 0064's pairing rule, path staleness, and the pins that keep the
 * table a trusted input to the gate rather than a file next to it.
 *
 * Every check that CAN fail closed is proven to fail: each has a negative
 * control that builds a deliberately broken table and asserts the check reds on
 * it. A check nobody has seen red is a check nobody knows works — this repo has
 * the scar, in a test that printed "All 0 deploy scripts…" and exited 0 over an
 * empty subject list.
 *
 * Run: pnpm gate:routing-table:test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { bashFunctionSource } from "../../sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";
import {
  exemptedLiterals,
  pairingProblems,
  stalenessSubjects,
} from "./checks.mjs";
import { parseGateRouting } from "./gate-arms.mjs";
import { literalPatternPath } from "./pattern.mjs";
import { ROUTING_GROUPS, ROUTING_PLAN } from "./index.mjs";
import { VERBS, normalizeGroups, walkArms } from "./schema.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
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
    "the assembled group order changed. Arm order and group order are both routing; " +
      "if this move is intended, the equality test against the gate's live arms has to agree.",
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

test("every verb in the closed set is a function the gate defines", () => {
  const gate = read("/scripts/agent-quality-gate.sh");
  for (const verb of Object.keys(VERBS)) {
    assert.ok(
      new RegExp(`^${verb}\\(\\) \\{`, "m").test(gate),
      `\`${verb}\` is in the table's verb set but \`scripts/agent-quality-gate.sh\` defines no such function`,
    );
  }
});

test("every verb's arity matches the gate's own routing call sites", () => {
  // Read the arities out of the parsed routing region rather than out of the
  // whole script. The gate's helper functions call the same verbs with computed
  // arguments — `add_command "$(turbo_local_cache_command …)" "$reason"` — and
  // counting quoted words there measures the substitution, not the call. The
  // routing region is the surface the table mirrors, so it is the surface whose
  // arities have to agree.
  const measured = new Map();
  const visit = (effects) => {
    for (const effect of effects) {
      if (effect.kind === "call") {
        const seen = measured.get(effect.verb) ?? new Set();
        seen.add(effect.args.length);
        measured.set(effect.verb, seen);
      }
      for (const nested of effect.arms ?? []) visit(nested.effects);
      if (effect.effects) visit(effect.effects);
    }
  };
  for (const group of parseGateRouting(
    read("/scripts/agent-quality-gate.sh"),
  )) {
    for (const armed of group.arms) visit(armed.effects);
  }
  for (const [verb, arities] of measured) {
    assert.deepEqual(
      [...arities],
      [VERBS[verb]],
      `the gate's routing region calls \`${verb}\` with ${[...arities].join(" and ")} arguments; the table records ${VERBS[verb]}`,
    );
  }
  assert.deepEqual(
    Object.keys(VERBS).filter((verb) => !measured.has(verb)),
    [],
    "the verb set holds a verb the routing region never reaches; a closed set that admits unreachable names is a spell check",
  );
});

test("the gate parser refuses an argument it cannot resolve", () => {
  // The parser records a quoted argument as its literal text, so anything the
  // shell would expand first means the table holds a command string that is not
  // the command the gate runs. Only the two loop variables the dynamic groups
  // pass are known; everything else is refused rather than stored raw.
  const region = (statement) =>
    [
      "while IFS= read -r path; do",
      '  case "$path" in',
      "    a)",
      `      ${statement}`,
      "      ;;",
      "  esac",
      'done < "$changed_paths_file"',
    ].join("\n");
  for (const statement of [
    'add_command "node ${RUNNER}/x.mjs" "why"',
    'add_command "node $RUNNER/x.mjs" "why"',
    'add_command "node `which node` x" "why"',
    'add_surface "$surface"',
    "add_surface $unknown_variable",
  ]) {
    assert.throws(
      () => parseGateRouting(region(statement)),
      /shell expansion this parser does not resolve|unrecognised bare argument|unrecognised routing statement/,
      `the parser accepted: ${statement}`,
    );
  }
  // The two shapes it must still accept: a plain literal, and a loop variable.
  assert.doesNotThrow(() => parseGateRouting(region('add_surface "docs"')));
  assert.doesNotThrow(() =>
    parseGateRouting(
      region('add_terraform_validate_commands "$terraform_stack_path" "why"'),
    ),
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

// --- pins ------------------------------------------------------------------

/**
 * Every module in this directory — tests included.
 *
 * The suites are in the signature for the same reason
 * `scripts/agent-quality-gate.test.sh` and
 * `scripts/terraform/terraform-fmt-check.test.mjs` already are: they are part of
 * what the gate proves about itself, so a stamp taken before one of them changed
 * should not be reused after. Excluding them would also make
 * `scripts/AGENTS.md`'s pin rule — "every `gate/routing-table/*.mjs` module" —
 * quietly untrue, and leave a class of file that can be added here without
 * anyone noticing it never joined the pin.
 */
const MODULES = readdirSync(HERE)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

/**
 * The source text of `implementation_signature()` ALONE.
 *
 * Searching the whole gate would let a comment or a routing reason string that
 * happens to name `scripts/gate/routing-table/foo.mjs` satisfy the pin while
 * the module is absent from the signature — the exact `__missing__`/frozen-stamp
 * failure the pin exists to catch. The gate already carries prose naming this
 * directory, so the scope is not hypothetical.
 *
 * The span comes from `bashFunctionSource`, which asks bash where the function
 * ends rather than looking for a closing brace: a textual terminator cannot see
 * a heredoc, a quoted `}`, or a trailer sharing the closing line.
 */
const SIGNATURE_SOURCE = bashFunctionSource(
  read("/scripts/agent-quality-gate.sh"),
  "implementation_signature",
  "scripts/agent-quality-gate.sh",
);

test("implementation_signature() lists every routing-table module", () => {
  // THE load-bearing pin. A path `implementation_signature()` cannot `stat`
  // hashes as the literal `__missing__`, which FREEZES the signature — so
  // `--skip-if-fresh` reuses a stale stamp and skips real pre-push work. A
  // module added here and not there fails that way and only that way.
  for (const module of MODULES) {
    assert.ok(
      SIGNATURE_SOURCE.includes(`gate/routing-table/${module}`),
      `\`implementation_signature()\` in scripts/agent-quality-gate.sh does not list gate/routing-table/${module}. ` +
        "A missing entry hashes as `__missing__` and freezes the freshness signature.",
    );
  }
});

test("implementation_signature() lists no routing-table module that is gone", () => {
  // The reverse of the check above, and it fails the same way: an entry the
  // signature cannot `stat` hashes as `__missing__` FOREVER, so the signature
  // stops moving and `--skip-if-fresh` reuses a stale stamp. A module that is
  // split or renamed leaves exactly this residue.
  const listed = [
    ...SIGNATURE_SOURCE.matchAll(
      /scripts\/gate\/routing-table\/([\w.-]+\.mjs)/g,
    ),
  ].map((match) => match[1]);
  const stale = [...new Set(listed)].filter((name) => !MODULES.includes(name));
  assert.deepEqual(
    stale,
    [],
    `scripts/agent-quality-gate.sh names routing-table modules that no longer exist: ${stale.join(", ")}`,
  );
});

test("the gate routes a change to this directory", () => {
  const gate = read("/scripts/agent-quality-gate.sh");
  assert.match(
    gate,
    /scripts\/gate\/routing-table\/\*\.mjs\)/,
    "scripts/agent-quality-gate.sh has no routing arm for scripts/gate/routing-table/*.mjs",
  );
  assert.match(gate, /pnpm gate:routing-table:test/);
});

test("turbo.json treats this directory as an input", () => {
  const turbo = read("/turbo.json");
  const occurrences = turbo.split("scripts/gate/routing-table/**").length - 1;
  assert.ok(
    occurrences >= 3,
    `turbo.json names scripts/gate/routing-table/** ${occurrences} times; the gate's two files are named in three tasks and the table belongs beside them`,
  );
});

test("scripts/AGENTS.md records the pin", () => {
  assert.match(read("/scripts/AGENTS.md"), /routing-table/);
});

test("ADR 0064's sweep checklist names the table", () => {
  assert.match(
    read("/docs/adr/0064-scripts-module-directories.md"),
    /gate\/routing-table/,
    "a scripts/ move has to update the routing DATA as well as the routing arms",
  );
});

test("every module is under the file-size hard cap", () => {
  for (const module of MODULES) {
    const lines = readFileSync(`${HERE}${module}`, "utf8").split("\n").length;
    assert.ok(
      lines < 1000,
      `${module} is ${lines} lines; the scripts/ hard cap is 1,000 and the table is split by family to stay under it`,
    );
  }
});
