#!/usr/bin/env node
/**
 * Structural assertion: every Sentry suite is reachable from CI, not only from
 * the local pre-push gate.
 *
 * Issue #1721: eight `sentry:*:test` scripts — roughly 400 assertions — were
 * enforced by the pre-push hook alone. `.github/workflows/ci.yml` invoked none
 * of them, so a contributor who bypassed the hook could merge a regression in
 * the triage or autofix leg against a fully green required check. Wiring the
 * suites in fixed that instance. This file is what stops it recurring: the
 * next suite that lands without a CI step fails here, on the `scripts` job
 * that is already required.
 *
 * Three invariants, each guarding a different way the wiring rots:
 *
 *   1. Every `scripts/sentry-*.test.mjs` is invoked by the `scripts` job —
 *      either through a `pnpm <alias>` whose package.json command names the
 *      file, or by a direct `node scripts/<file>`. A suite may be exempted
 *      only by naming the CI job that does run it, and the exemption is
 *      re-proven below rather than trusted.
 *   2. Every `sentry:*:test` package script resolves to a file this check
 *      enumerates, so a suite cannot dodge invariant 1 by living elsewhere.
 *   3. The local gate's tooling allowlist in scripts/agent-quality-gate.sh
 *      lists every `sentry:*` script. That allowlist decides whether a
 *      root package.json edit is scoped to root tooling; a missing entry is
 *      conservative (the gate runs broader, never narrower) but it is still
 *      drift, and it drifted for `sentry:project`, `sentry:project:test`,
 *      and `sentry:requeue:test` before this check existed.
 *
 * No external dependencies — reads files with pure Node.js.
 *
 * Run: `node scripts/check-sentry-suites-in-ci.test.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS_DIR = join(ROOT, "scripts");

const CI_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const CI = readFileSync(CI_PATH, "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PKG_SCRIPTS = PKG.scripts ?? {};
const GATE = readFileSync(join(SCRIPTS_DIR, "agent-quality-gate.sh"), "utf8");

/** This file, so the check can assert its own CI step still exists. */
const SELF = "check-sentry-suites-in-ci.test.mjs";

/**
 * Sentry-named suites that another CI job owns. The value is the route, and
 * `the exemptions still hold` re-proves each one — an exemption whose route
 * disappeared is a hole, not an exemption.
 */
const RUN_BY_ANOTHER_JOB = new Map([
  [
    "sentry-provider-contract.test.mjs",
    "imported by scripts/tf-stacks.test.mjs, which `pnpm tf:test` runs in the " +
      "unconditional `Production infrastructure contract` job",
  ],
]);

// ── ci.yml parsing ───────────────────────────────────────────────────────────

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The body of a top-level job in ci.yml, from its key to the next job's.
 * @param {string} name
 */
function jobBlock(name) {
  const key = `\n  ${name}:\n`;
  const start = CI.indexOf(key);
  assert.ok(start >= 0, `the \`${name}\` job was not found in ${CI_PATH}`);
  const body = CI.slice(start + key.length);
  const next = body.search(/\n {2}[A-Za-z][A-Za-z0-9_-]*:\n/);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * The `scripts` job with full-line YAML comments removed. Several steps in
 * that job carry comments naming the suites they run; matching against the
 * raw body would let a comment alone satisfy this check.
 */
const SCRIPTS_JOB = jobBlock("scripts")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * The whole workflow with full-line YAML comments removed. Exemption re-proofs
 * point at steps in OTHER jobs, so they cannot use `SCRIPTS_JOB` — but they
 * need the same protection: matching raw text would let a commented-out step
 * keep an exemption green after the real step was deleted.
 */
const CI_WITHOUT_COMMENTS = CI.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * Every executable command in the `scripts` job: the value of each `run:` key,
 * plus the continuation lines of block scalars (`run: |`).
 *
 * Searching the whole job body would let ANY occurrence satisfy the invariant —
 * `run: echo "temporarily disabled: pnpm sentry:requeue:test"` would count as
 * running the suite. Commands are collected from `run:` positions only, and a
 * command quoted inside another command's arguments is not one of them.
 */
const SCRIPTS_JOB_COMMANDS = (() => {
  const commands = [];
  const lines = SCRIPTS_JOB.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const inline = /^\s*(?:-\s+)?run:\s*(?![|>])(\S.*)$/.exec(lines[i]);
    if (inline) {
      commands.push(inline[1].trim());
      continue;
    }
    const block = /^(\s*)(?:-\s+)?run:\s*[|>][+-]?\s*$/.exec(lines[i]);
    if (!block) continue;
    const indent = block[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") continue;
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      commands.push(line.trim());
    }
  }
  return commands;
})();

/**
 * Does the `scripts` job run this command? True only when the command appears
 * at the START of an executable `run:` command — so it cannot be satisfied by
 * the command's name appearing inside another command's arguments.
 * @param {string} command
 */
function scriptsJobRuns(command) {
  // The trailing guard keeps `pnpm sentry:archive` from matching a job that
  // only runs `pnpm sentry:archive:test`.
  const pattern = new RegExp(`^${escapeRegExp(command)}(?![\\w:.-])`);
  return SCRIPTS_JOB_COMMANDS.some((entry) => pattern.test(entry));
}

/**
 * package.json aliases whose command invokes this script file.
 * @param {string} file
 */
function aliasesFor(file) {
  return Object.entries(PKG_SCRIPTS)
    .filter(([, command]) => command.includes(`scripts/${file}`))
    .map(([name]) => name);
}

/** @param {string} file */
function invokedByScriptsJob(file) {
  if (scriptsJobRuns(`node scripts/${file}`)) return true;
  if (scriptsJobRuns(`node --test scripts/${file}`)) return true;
  return aliasesFor(file).some((alias) => scriptsJobRuns(`pnpm ${alias}`));
}

const SENTRY_SUITES = readdirSync(SCRIPTS_DIR)
  .filter((file) => file.startsWith("sentry-") && file.endsWith(".test.mjs"))
  .sort();

// ── invariants ───────────────────────────────────────────────────────────────

test("the enumeration found the Sentry suites at all", () => {
  // A rename or a moved directory must fail loudly rather than vacuously pass
  // every assertion below.
  assert.ok(
    SENTRY_SUITES.length >= 8,
    `expected at least 8 scripts/sentry-*.test.mjs suites, found ${SENTRY_SUITES.length}`,
  );
});

test("every Sentry suite is invoked by the ci.yml `scripts` job", () => {
  const missing = SENTRY_SUITES.filter(
    (file) => !RUN_BY_ANOTHER_JOB.has(file) && !invokedByScriptsJob(file),
  );
  assert.deepEqual(
    missing,
    [],
    `these Sentry suites run nowhere in CI: ${missing.join(", ")}. ` +
      "Add a step to the `scripts` job in .github/workflows/ci.yml, or add an " +
      "entry to RUN_BY_ANOTHER_JOB naming the job that does run it.",
  );
});

test("the exemptions still hold", () => {
  for (const [file, route] of RUN_BY_ANOTHER_JOB) {
    assert.ok(
      SENTRY_SUITES.includes(file),
      `RUN_BY_ANOTHER_JOB names ${file}, which no longer exists — drop the entry`,
    );
    // The one exemption's route: tf-stacks.test.mjs imports it, and ci.yml
    // runs `pnpm tf:test`. Both halves must still be true.
    assert.equal(
      file,
      "sentry-provider-contract.test.mjs",
      `unproven exemption for ${file} (${route}) — extend this test to re-prove its route`,
    );
    const tfStacks = readFileSync(
      join(SCRIPTS_DIR, "tf-stacks.test.mjs"),
      "utf8",
    );
    assert.match(
      tfStacks,
      new RegExp(`import\\s+["']\\./${escapeRegExp(file)}["']`),
      `${file} is exempted because tf-stacks.test.mjs imports it, but that import is gone`,
    );
    assert.match(
      CI_WITHOUT_COMMENTS,
      /run: pnpm tf:test/,
      `${file} is exempted because CI runs \`pnpm tf:test\`, but that step is gone`,
    );
  }
});

test("every sentry:*:test script resolves to an enumerated suite", () => {
  const aliases = Object.keys(PKG_SCRIPTS).filter(
    (name) => name.startsWith("sentry:") && name.endsWith(":test"),
  );
  assert.ok(
    aliases.length > 0,
    "no sentry:*:test scripts found in package.json",
  );

  const unresolved = aliases.filter(
    (alias) =>
      !SENTRY_SUITES.some((file) =>
        PKG_SCRIPTS[alias].includes(`scripts/${file}`),
      ),
  );
  assert.deepEqual(
    unresolved,
    [],
    `these sentry:*:test scripts do not point at a scripts/sentry-*.test.mjs ` +
      `file, so the CI-coverage assertion above cannot see them: ${unresolved.join(", ")}`,
  );
});

test("the local gate's tooling allowlist lists every sentry:* script", () => {
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();
  const missing = sentryScripts.filter(
    (name) =>
      !GATE.includes(`/scripts/${name}|`) &&
      !GATE.includes(`/scripts/${name})`),
  );
  assert.deepEqual(
    missing,
    [],
    "classify_root_package_json_changes in scripts/agent-quality-gate.sh does " +
      `not list: ${missing.join(", ")}. Without the entry, a package.json edit ` +
      "touching only that script classifies as `package-scripts` instead of " +
      "`root-tooling-scripts` — conservative, but drift.",
  );
});

test("this check itself runs in the ci.yml `scripts` job", () => {
  // Without this, the meta-check could be dropped from CI and every invariant
  // above would go quiet.
  assert.ok(
    scriptsJobRuns(`node scripts/${SELF}`),
    `the \`scripts\` job must run \`node scripts/${SELF}\``,
  );
});
