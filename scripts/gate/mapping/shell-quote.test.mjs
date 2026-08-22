#!/usr/bin/env node
/**
 * `shellQuote` against bash itself.
 *
 * It reimplements `printf %q`, which several routed commands depend on, and the
 * command string is what the freshness stamp hashes — so a single wrong
 * backslash is a plan that never matches the gate's. The rules are not
 * guessable (`#` and `~` are left alone mid-string, `,` and `^` are not), so
 * this asks the shell rather than asserting a table of remembered answers.
 *
 * Every installed bash is driven, because 3.2 is what the pre-push hook runs on
 * a Mac and 5.x is what a developer's PATH usually has.
 *
 * Run: node --test scripts/gate/mapping/shell-quote.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

import { shellQuote } from "./shell-quote.mjs";

/** Every distinct bash on this machine, by resolved path. */
function bashInterpreters() {
  const resolved = new Map();
  for (const candidate of [
    "/bin/bash",
    "bash",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
  ]) {
    const found = spawnSync(
      candidate,
      ["-c", 'printf "%s %s" "$BASH" "$BASH_VERSION"'],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        timeout: 30_000,
      },
    );
    if (found.error || found.status !== 0) continue;
    const [path, version] = found.stdout.trim().split(" ");
    if (path?.startsWith("/") && !resolved.has(path))
      resolved.set(path, version);
  }
  return resolved;
}

/**
 * The subjects. Deliberately heavy on the characters where a hand-written
 * implementation goes wrong, plus the ordinary repo paths that must come back
 * untouched — if those were escaped, every command in the plan would differ.
 */
const SUBJECTS = [
  "scripts/agent-quality-gate.sh",
  "ui-dashboard/src/lib/__generated__/graphql.ts",
  "docs/notes/a-b_c.1.md",
  "alerts/infra/oncall-announcer/vitest.config.ts",
  "a b",
  "a'b",
  'a"b',
  "a$b",
  "a*b",
  "a[b]",
  "a(b)",
  "a&b",
  "a;b",
  "a|b",
  "a\\b",
  "a!b",
  "a#b",
  "a~b",
  "a=b",
  "a:b",
  "a@b",
  "a%b",
  "a+b",
  "a,b",
  "a^b",
  "a{b}",
  "a<b>",
  "a?b",
  "a`b",
  "",
  "ui-dashboard/src/app/pool/[poolId]/page.tsx",
  "weird name with spaces.ts",
];

const interpreters = bashInterpreters();

test("at least one bash was found to check against", () => {
  assert.ok(interpreters.size > 0, "no usable bash on this machine");
});

for (const [bash, version] of interpreters) {
  test(`shellQuote matches printf %q on ${bash} (${version})`, () => {
    // One spawn for the whole corpus: the subjects go in on stdin, one per
    // line, and come back `%q`-quoted in the same order.
    const script = `
      while IFS= read -r line; do printf '%q\\n' "$line"; done
    `;
    const output = execFileSync(bash, ["-c", script], {
      input: `${SUBJECTS.join("\n")}\n`,
      encoding: "utf8",
    });
    const expected = output.split("\n").slice(0, SUBJECTS.length);

    const disagreements = [];
    SUBJECTS.forEach((subject, index) => {
      const mine = shellQuote(subject);
      if (mine !== expected[index]) {
        disagreements.push(
          `${JSON.stringify(subject)}: bash ${JSON.stringify(expected[index])}, shellQuote ${JSON.stringify(mine)}`,
        );
      }
    });
    assert.deepEqual(
      disagreements,
      [],
      `shellQuote disagrees with ${bash}:\n  - ${disagreements.join("\n  - ")}`,
    );
  });
}

test("ordinary repository paths are returned untouched", () => {
  // The case that matters most in practice: if these were escaped, every
  // templated command in the plan would differ from the gate's.
  for (const path of [
    "scripts/agent-quality-gate.sh",
    "docs/adr/0069-gate-routing-table-as-data.md",
    "indexer-envio/src/EventHandlers.ts",
  ]) {
    assert.equal(shellQuote(path), path);
  }
});
