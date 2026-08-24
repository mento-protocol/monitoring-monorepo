#!/usr/bin/env node
/**
 * The pins that keep the routing table a trusted input to the gate rather than
 * a file next to it: `implementation_signature()`, the table's own routing arm,
 * the Turbo inputs, the `scripts/AGENTS.md` pin registry, ADR 0064's sweep
 * checklist, and the per-module size cap.
 *
 * Split out of `routing-table.test.mjs` at D5c, which took that file to the
 * 1,000-line hard cap. Both halves run under the same alias, so nothing about
 * what is checked moved — only where it is written.
 *
 * The pin that must not be forgotten is the first one. A path
 * `implementation_signature()` cannot `stat` hashes as the literal `__missing__`,
 * which FREEZES the freshness signature: `--skip-if-fresh` then reuses a stale
 * stamp and skips real pre-push work, and nothing reds.
 *
 * Run: pnpm gate:routing-table:test
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { bashFunctionSource } from "../../sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";
import { ROUTING_GROUPS } from "./index.mjs";
import { walkArms } from "./schema.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (relative) => readFileSync(`${REPO}${relative}`, "utf8");

/**
 * Every module in this directory — tests included.
 *
 * The suites are in the signature for the same reason
 * `scripts/agent-quality-gate.test.sh` and
 * `scripts/terraform/terraform-fmt-check.test.mjs` already are: they are part of
 * what the gate proves about itself, so a stamp taken before one of them changed
 * should not be reused after. Excluding them would also make
 * `scripts/AGENTS.md`'s pin rule quietly untrue.
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

/**
 * The paths `implementation_signature()` actually iterates, as whole words.
 *
 * Substring matching was the wrong question twice over: an unlisted `foo.mjs`
 * passes if its name is a substring of a listed entry, and any mention in a
 * comment satisfies the pin without the path ever being hashed. Both report a
 * pin that is not there, which is the `__missing__` freeze this exists to catch.
 *
 * The list is a bare `for path in … ; do` word list, so it is read as one: take
 * the span between the two, drop comments and line continuations, split on
 * whitespace. An entry that is not a whole word in that span is not an entry.
 */
const SIGNATURE_ENTRIES = (() => {
  const span = /for path in\b([\s\S]*?);\s*do\b/.exec(SIGNATURE_SOURCE);
  assert.ok(
    span !== null,
    "implementation_signature() no longer iterates a `for path in … ; do` list; this pin cannot read it",
  );
  const entries = span[1]
    .replace(/#[^\n]*/g, "")
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");
  // Sanity: the list must still hold the gate's own two files. If it does not,
  // the span was parsed wrongly and every assertion below would be vacuous.
  for (const known of [
    "scripts/agent-quality-gate.sh",
    "scripts/agent-quality-gate.test.sh",
  ]) {
    assert.ok(
      entries.includes(known),
      `parsed ${entries.length} signature entries and ${known} was not among them, so the span was read wrongly`,
    );
  }
  return entries;
})();

test("the signature pin reads whole entries, not substrings", () => {
  // Both substring hazards, asserted against the parsed entry list: a name that
  // is a substring of a listed entry is not itself listed, and a path that only
  // appears in a comment is not an entry at all.
  assert.ok(SIGNATURE_ENTRIES.includes("scripts/gate/routing-table/index.mjs"));
  assert.ok(
    !SIGNATURE_ENTRIES.includes("scripts/gate/routing-table/dex.mjs"),
    "a substring of a listed entry was read as an entry",
  );
  assert.ok(
    !SIGNATURE_ENTRIES.some((entry) => entry.includes("#")),
    "a comment survived into the parsed entry list",
  );
  assert.ok(
    SIGNATURE_ENTRIES.every((entry) => !/\s/.test(entry) && entry !== "\\"),
    "the entry list holds something that is not a bare path word",
  );
});

test("implementation_signature() lists every routing-table module", () => {
  // THE load-bearing pin. A path `implementation_signature()` cannot `stat`
  // hashes as the literal `__missing__`, which FREEZES the signature — so
  // `--skip-if-fresh` reuses a stale stamp and skips real pre-push work. A
  // module added here and not there fails that way and only that way.
  for (const module of MODULES) {
    assert.ok(
      SIGNATURE_ENTRIES.includes(`scripts/gate/routing-table/${module}`),
      `\`implementation_signature()\` in scripts/agent-quality-gate.sh does not list scripts/gate/routing-table/${module} as an entry. ` +
        "A missing entry hashes as `__missing__` and freezes the freshness signature.",
    );
  }
});

test("implementation_signature() lists no routing-table module that is gone", () => {
  // The reverse of the check above, and it fails the same way: an entry the
  // signature cannot `stat` hashes as `__missing__` FOREVER, so the signature
  // stops moving and `--skip-if-fresh` reuses a stale stamp. A module that is
  // split or renamed leaves exactly this residue.
  // Whole entries, for the same reason as the forward check: a path mentioned
  // in a comment is not something the signature hashes, and reading one as an
  // entry would make this report a stale pin that does not exist.
  const prefix = "scripts/gate/routing-table/";
  const listed = SIGNATURE_ENTRIES.filter((entry) =>
    entry.startsWith(prefix),
  ).map((entry) => entry.slice(prefix.length));
  const stale = [...new Set(listed)].filter((name) => !MODULES.includes(name));
  assert.deepEqual(
    stale,
    [],
    `scripts/agent-quality-gate.sh names routing-table modules that no longer exist: ${stale.join(", ")}`,
  );
});

test("the table routes a change to this directory", () => {
  // Read out of the data, not out of the gate's source text: since D5c the gate
  // holds no `case` arms, and a regex over its prose would pass on a comment.
  // The self-test rides along because it is what proves
  // `implementation_signature()` still lists every module here.
  const arms = walkArms(ROUTING_GROUPS).filter(({ arm }) =>
    (arm.patterns ?? []).includes("scripts/gate/routing-table/*.mjs"),
  );
  assert.equal(arms.length, 1, "the table has no arm for its own directory");
  const commands = arms[0].arm.effects.map((effect) => effect.command);
  for (const expected of [
    "pnpm gate:routing-table:test",
    "pnpm agent:quality-gate:test",
  ]) {
    assert.ok(
      commands.includes(expected),
      `the arm for this directory schedules ${JSON.stringify(commands)}, without \`${expected}\``,
    );
  }
});

/** The Turbo tasks that carry the gate's own two files, and so must carry the table. */
const TURBO_GATE_TASKS = ["build", "size-limit", "test:browser"];

test("turbo.json lists this directory as an input of every gate task", () => {
  // Parsed, and matched against the exact input string in the exact task's
  // `inputs` array. Counting occurrences of the glob in the file text was the
  // wrong question twice over: a match in an unrelated key or an unused task
  // satisfied it, and a total says nothing about WHICH tasks list the input —
  // which is the whole property. A task that drops the input stops rebuilding
  // when the routing changes, and nothing else reds.
  const turbo = JSON.parse(read("/turbo.json"));
  const input = "$TURBO_ROOT$/scripts/gate/routing-table/**";
  for (const task of TURBO_GATE_TASKS) {
    assert.ok(
      turbo.tasks?.[task]?.inputs?.includes(input),
      `turbo task \`${task}\` does not list ${input} as an input, so it will not rebuild when the routing table changes`,
    );
  }
});

test("scripts/AGENTS.md records the pin", () => {
  assert.match(read("/scripts/AGENTS.md"), /routing-table/);
});

test("ADR 0064's sweep checklist names the table", () => {
  assert.match(
    read("/docs/adr/0064-scripts-module-directories.md"),
    /gate\/routing-table/,
    "a scripts/ move has to update the routing table, which is where routing lives",
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
