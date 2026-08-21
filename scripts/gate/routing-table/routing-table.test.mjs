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

import { pairingProblems, stalenessSubjects } from "./checks.mjs";
import { parseGateRouting } from "./gate-arms.mjs";
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
        arms: [arm(["${some_target}/*"])],
      }),
    ),
  );
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
  for (const { groupId, arm } of walkArms(ROUTING_GROUPS)) {
    if (typeof arm.allowStale !== "string") continue;
    assert.ok(
      arm.allowStale.length > 20,
      `group \`${groupId}\`: an \`allowStale\` reason has to say why, not just that`,
    );
    assert.ok(
      arm.patterns.some((pattern) => !existsSync(`${REPO}/${pattern}`)),
      `group \`${groupId}\`, arm [${arm.patterns.join(" | ")}]: every path it exempts now exists, so the exemption is dead and should go`,
    );
  }
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

/** Every module in this directory that the gate has to know about. */
const MODULES = readdirSync(HERE)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .sort();

test("implementation_signature() lists every routing-table module", () => {
  // THE load-bearing pin. A path `implementation_signature()` cannot `stat`
  // hashes as the literal `__missing__`, which FREEZES the signature — so
  // `--skip-if-fresh` reuses a stale stamp and skips real pre-push work. A
  // module added here and not there fails that way and only that way.
  const gate = read("/scripts/agent-quality-gate.sh");
  for (const module of MODULES) {
    assert.ok(
      gate.includes(`gate/routing-table/${module}`),
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
    ...read("/scripts/agent-quality-gate.sh").matchAll(
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
