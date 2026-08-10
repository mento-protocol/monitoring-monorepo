#!/usr/bin/env node
/**
 * Structural assertion: every Sentry suite is reachable from CI, not only from
 * the local pre-push gate.
 *
 * Issue #1721: eight `sentry:*:test` scripts — roughly 400 assertions — were
 * enforced by the pre-push hook alone. `.github/workflows/ci.yml` invoked none
 * of them, so a contributor who bypassed the hook could merge a regression in
 * the triage or autofix leg against a fully green required check. Wiring the
 * suites fixed that instance. This file stops it recurring: the next suite
 * that lands without a CI step fails here, on the `scripts` job that is
 * already required.
 *
 * EVERY assertion reads a parsed structure. Six review rounds against the
 * text-matching version of this file found the same defect in a new place each
 * time — a commented-out step, a commented-out import, a commented-out filter
 * path, an `echo` naming a suite, an `if: false`, a `|| true`. Each is
 * invisible to a parser and each defeated a substring search. So:
 *
 *   ci.yml               js-yaml, then walked as objects
 *   the paths filter     js-yaml again, on the inner YAML document that lives
 *                        inside the filter step's string value
 *   `run:` commands      tokenized against a plain-word grammar and matched
 *                        whole, never by prefix
 *   tf-stacks.test.mjs   V8's own parser (vm.SourceTextModule) reports the
 *                        static import list, with nothing executed
 *   the gate allowlist   bash evaluates its own `case` statement
 *   the validator pins   the validator reports them itself
 *
 * An unparsable ci.yml throws here, and that is correct: this same job runs
 * scripts/check-autofix-ci-trust.mjs, which already fails closed on one.
 *
 * Three invariants, each guarding a different way the wiring rots:
 *
 *   1. Every `scripts/sentry-*.test.mjs` is invoked by the `scripts` job —
 *      through a `pnpm <alias>` whose package.json command runs the file, or
 *      by a direct `node scripts/<file>`. A suite may be exempted only by
 *      naming the CI job that does run it, and the exemption is re-proven
 *      below rather than trusted.
 *   2. Every `sentry:*:test` package script resolves to a file this check
 *      enumerates, so a suite cannot dodge invariant 1 by living elsewhere.
 *   3. The local gate's tooling allowlist in scripts/agent-quality-gate.sh
 *      lists every `sentry:*` script, and every listed script is pinned to an
 *      exact command by check-agent-quality-gate-package-scripts.sh. The
 *      allowlist grants trust; the pin is what makes that trust safe.
 *
 * Run: `node scripts/check-sentry-suites-in-ci.test.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS_DIR = join(ROOT, "scripts");
const CI_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const GATE_PATH = join(SCRIPTS_DIR, "agent-quality-gate.sh");
const VALIDATOR_PATH = join(
  SCRIPTS_DIR,
  "check-agent-quality-gate-package-scripts.sh",
);

/** This file, so the check can assert its own CI step still exists. */
const SELF = "scripts/check-sentry-suites-in-ci.test.mjs";

// A throw here is the intended failure mode for a malformed workflow.
const CI = load(readFileSync(CI_PATH, "utf8"), { schema: CORE_SCHEMA });
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PKG_SCRIPTS = PKG.scripts ?? {};
const GATE = readFileSync(GATE_PATH, "utf8");

/**
 * Every `sentry-*.test.mjs` under scripts/, at any depth, as a repo-relative
 * path. Recursive so a suite cannot hide from invariant 1 by moving into a
 * subdirectory.
 *
 * @param {string} dir
 * @param {string} prefix
 */
function findSentrySuites(dir, prefix = "scripts") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...findSentrySuites(join(dir, entry.name), relative));
    } else if (
      entry.name.startsWith("sentry-") &&
      entry.name.endsWith(".test.mjs")
    ) {
      found.push(relative);
    }
  }
  return found.sort();
}

const SENTRY_SUITES = findSentrySuites(SCRIPTS_DIR);

/**
 * Sentry-named suites that another CI job owns. The value names the route;
 * `the exemption for sentry-provider-contract still holds` re-proves it. An
 * exemption whose route disappeared is a hole, not an exemption.
 */
const RUN_BY_ANOTHER_JOB = new Map([
  [
    "scripts/sentry-provider-contract.test.mjs",
    "imported by scripts/tf-stacks.test.mjs, which `pnpm tf:test` runs in the " +
      "unconditional `Production infrastructure contract` job",
  ],
]);

/**
 * The jobs this file trusts to run its assertions, and the ONLY `if:` each may
 * carry. `null` means the job must be unconditional.
 *
 * `scripts` is path-gated, so its guard is pinned to an exact string and
 * `the scripts job stays reachable from the paths its suites guard` follows
 * that string through the paths filter. Any edit to the guard fails here and
 * has to be re-proven, which is the point.
 */
const TRUSTED_JOBS = new Map([
  ["scripts", "needs.changes.outputs.rootScripts == 'true'"],
  ["production-infra-contract", null],
]);

/**
 * Paths whose edits must re-run the `scripts` job. Every one is an input to a
 * suite that job owns: the suites themselves, the workflow files
 * sentry-mcp-broker.test.mjs parses, and the manifest holding the aliases the
 * CI steps invoke.
 */
const REQUIRED_ROOT_SCRIPT_PATHS = [
  "scripts/**/*.mjs",
  ".github/workflows/**",
  "package.json",
];

/**
 * Env names proven not to change any suite's behaviour. Empty on purpose: an
 * `env:` on a job or an invoking step can flip a suite into a no-op, and this
 * file cannot tell which. Add a name here only with that proof.
 */
const PROVEN_INERT_ENV = new Set();

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── shell command grammar ────────────────────────────────────────────────────

/**
 * Characters a bare word may contain. Everything that can redirect, chain,
 * background, group, substitute, glob, or quote is absent, so a line built
 * only from these words is a single simple command whose exit status the
 * step's `bash -e` propagates.
 */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Words that stop a line from being a simple command, or that change the
 * shell state the exit-status reasoning rests on. `set +e` is the obvious one;
 * the keywords matter because `if pnpm x` puts `pnpm x` in a condition, where
 * a failure is swallowed.
 */
const NOT_A_SIMPLE_COMMAND = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "time",
  "set",
  "shopt",
  "trap",
  "exec",
  "eval",
  "source",
  ".",
  "export",
  "declare",
  "local",
  "readonly",
  "alias",
  "unalias",
  "exit",
  "return",
  "break",
  "continue",
]);

/**
 * Split a shell script into the simple commands it runs, or explain why it
 * cannot be read that way.
 *
 * An allowlist, not a blacklist of dangerous suffixes: a line counts only when
 * every word is bare. `pnpm sentry:requeue:test || true` fails because `|` is
 * not a bare-word character, and so does `; true`, `|| :`, a trailing `&`, a
 * `$(…)`, and a redirect. Blacklisting suffixes would have to enumerate those;
 * this cannot miss one.
 *
 * @param {string} script
 * @returns {{ commands: string[][], blocker: string | null }}
 */
function parseShellScript(script) {
  const commands = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const words = trimmed.split(/[ \t]+/);
    if (!words.every((word) => BARE_WORD.test(word))) {
      return {
        commands: [],
        blocker: `\`${trimmed}\` is not a plain command — shell syntax here can mask a non-zero exit`,
      };
    }
    if (NOT_A_SIMPLE_COMMAND.has(words[0])) {
      return {
        commands: [],
        blocker: `\`${trimmed}\` starts with \`${words[0]}\`, which can change the shell state or swallow a failure`,
      };
    }
    commands.push(words);
  }
  return { commands, blocker: null };
}

/**
 * @param {string[]} command
 * @param {string[]} target
 */
function isCommand(command, target) {
  return (
    command.length === target.length &&
    command.every((word, index) => word === target[index])
  );
}

/**
 * Does any command match `target` exactly?
 *
 * Exact, not prefix-with-extra-arguments: `node scripts/x.test.mjs
 * --test-name-pattern=nothing` runs the file and asserts nothing, and
 * `--test-only` does the same. A trailing argument is as good a bypass as a
 * trailing `|| true`, so neither is accepted.
 *
 * @param {string[][]} commands
 * @param {string[]} target
 */
function runsCommand(commands, target) {
  return commands.some((command) => isCommand(command, target));
}

// ── ci.yml structure ─────────────────────────────────────────────────────────

/**
 * Workflow-scope settings that reach into every job: a `defaults.run` can move
 * the working directory or swap the shell out from under a step, and a
 * workflow-level `env:` reaches the suites the same way a step-level one does.
 */
function workflowBlockers() {
  const blockers = [];
  if (CI.defaults !== undefined) {
    blockers.push(
      "ci.yml declares workflow-level `defaults:`, which can redirect every job's shell or working directory",
    );
  }
  for (const key of Object.keys(CI.env ?? {})) {
    if (!PROVEN_INERT_ENV.has(key)) {
      blockers.push(
        `ci.yml sets workflow-level \`env.${key}\`, which may change what a suite does`,
      );
    }
  }
  return blockers;
}

/** @param {string} name */
function ciJob(name) {
  assert.ok(isPlainObject(CI?.jobs), `${CI_PATH} declares no \`jobs:\` map`);
  const job = CI.jobs[name];
  assert.ok(
    isPlainObject(job),
    `the \`${name}\` job was not found in ${CI_PATH}`,
  );
  return job;
}

/** @param {unknown} needs */
function needsList(needs) {
  if (needs === undefined) return [];
  if (typeof needs === "string") return [needs];
  assert.ok(
    Array.isArray(needs),
    "a job's `needs:` must be a string or a list",
  );
  return needs;
}

/**
 * Everything that stops a job from running to completion and failing the
 * workflow when a step fails. Its `if:` is checked against TRUSTED_JOBS, so a
 * changed guard shows up here rather than silently gating the suites.
 *
 * @param {string} name
 * @param {Set<string>} [seen]
 */
function jobBlockers(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const job = ciJob(name);
  const blockers = [];

  const allowedIf = TRUSTED_JOBS.has(name) ? TRUSTED_JOBS.get(name) : null;
  if (job.if !== undefined && job.if !== allowedIf) {
    blockers.push(
      allowedIf === null
        ? `\`${name}\` gained an \`if: ${job.if}\` — it must run unconditionally`
        : `\`${name}\` has \`if: ${job.if}\`, not the guard this file re-proves (\`${allowedIf}\`)`,
    );
  }
  if (job.if === undefined && allowedIf !== null) {
    blockers.push(
      `\`${name}\` lost its \`if: ${allowedIf}\` — update TRUSTED_JOBS and the reachability proof`,
    );
  }
  if (
    job["continue-on-error"] !== undefined &&
    job["continue-on-error"] !== false
  ) {
    blockers.push(
      `\`${name}\` sets \`continue-on-error\`, so a failing suite still reports success`,
    );
  }
  if (job.strategy !== undefined) {
    blockers.push(
      `\`${name}\` has a \`strategy:\` — a matrix can expand to zero jobs, which reads as a skip`,
    );
  }
  if (job.environment !== undefined) {
    blockers.push(
      `\`${name}\` targets an \`environment:\`, whose protection rules can hold or reject the run`,
    );
  }
  if (job.container !== undefined || job.services !== undefined) {
    blockers.push(
      `\`${name}\` declares a \`container:\`/\`services:\`, which changes the runtime the suites see`,
    );
  }
  if (job.defaults !== undefined) {
    blockers.push(
      `\`${name}\` declares \`defaults:\`, which can redirect the shell or the working directory`,
    );
  }
  if (job.uses !== undefined) {
    blockers.push(
      `\`${name}\` calls a reusable workflow, so its steps are not in this file`,
    );
  }
  for (const key of Object.keys(job.env ?? {})) {
    if (!PROVEN_INERT_ENV.has(key)) {
      blockers.push(
        `\`${name}\` sets \`env.${key}\`, which may change what a suite does`,
      );
    }
  }
  if (!Array.isArray(job.steps)) {
    blockers.push(`\`${name}\` has no \`steps:\` list`);
  }

  for (const dependency of needsList(job.needs)) {
    if (!isPlainObject(CI.jobs?.[dependency])) {
      blockers.push(
        `\`${name}\` needs \`${dependency}\`, which does not exist — the job can never start`,
      );
      continue;
    }
    blockers.push(...jobBlockers(dependency, seen));
  }
  return blockers;
}

/**
 * Everything that stops a step's `run:` from executing and failing the job.
 * @param {Record<string, unknown>} step
 */
function stepBlockers(step) {
  const blockers = [];
  if (step.if !== undefined) {
    blockers.push(`\`if: ${step.if}\` — a condition can skip it`);
  }
  if (
    step["continue-on-error"] !== undefined &&
    step["continue-on-error"] !== false
  ) {
    blockers.push("`continue-on-error` — a failure would not fail the job");
  }
  if (
    step["working-directory"] !== undefined &&
    step["working-directory"] !== "."
  ) {
    blockers.push(
      `\`working-directory: ${step["working-directory"]}\` — \`pnpm <alias>\` would resolve a different package.json`,
    );
  }
  // GitHub's default shell and both `bash` and `sh` run with `-e`, which is
  // what makes a failing line fail the step. Anything else has to prove it.
  if (
    step.shell !== undefined &&
    step.shell !== "bash" &&
    step.shell !== "sh"
  ) {
    blockers.push(
      `\`shell: ${step.shell}\` — this file only reasons about \`bash\`/\`sh\`, which run with \`-e\``,
    );
  }
  for (const key of Object.keys(step.env ?? {})) {
    if (!PROVEN_INERT_ENV.has(key)) {
      blockers.push(`\`env.${key}\` — it may change what the command does`);
    }
  }
  return blockers;
}

/**
 * Every command a job is proven to run, with its exit status reaching the job.
 * A step that cannot be proven contributes nothing, so an unreadable step
 * reads as "does not run the suite" — which fails closed.
 *
 * @param {string} name
 */
function provenCommands(name) {
  const commands = [];
  for (const step of ciJob(name).steps ?? []) {
    if (!isPlainObject(step) || typeof step.run !== "string") continue;
    if (stepBlockers(step).length > 0) continue;
    commands.push(...parseShellScript(step.run).commands);
  }
  return commands;
}

/**
 * Why a job does not run `target`, listing the steps that tried. Used for
 * failure messages so a rejected `|| true` says so instead of reading as a
 * missing step.
 *
 * @param {string} name
 * @param {string[][]} targets
 */
function nearMisses(name, targets) {
  const notes = [];
  for (const step of ciJob(name).steps ?? []) {
    if (!isPlainObject(step) || typeof step.run !== "string") continue;
    const mentionsTarget = targets.some((target) =>
      target.every((word) => step.run.includes(word)),
    );
    if (!mentionsTarget) continue;
    const blockers = stepBlockers(step);
    if (blockers.length > 0) {
      notes.push(`step \`${step.name ?? step.run}\`: ${blockers.join("; ")}`);
      continue;
    }
    const { commands, blocker } = parseShellScript(step.run);
    if (blocker) {
      notes.push(`step \`${step.name ?? step.run}\`: ${blocker}`);
    } else if (!targets.some((target) => runsCommand(commands, target))) {
      notes.push(
        `step \`${step.name ?? step.run}\`: runs \`${step.run.trim()}\`, which is not one of ` +
          targets.map((target) => `\`${target.join(" ")}\``).join(" / "),
      );
    }
  }
  return notes;
}

// ── package.json aliases ─────────────────────────────────────────────────────

/**
 * The package.json aliases that actually run this suite file.
 *
 * The command is tokenized and matched whole, so
 * `"sentry:ingest:test": "echo scripts/x.mjs"` and
 * `"sentry:ingest:test": "node scripts/x.mjs || true"` both fail to resolve —
 * the CI step would run, the suite would not.
 *
 * @param {string} file repo-relative path, e.g. `scripts/sentry-x.test.mjs`
 */
function aliasesFor(file) {
  const targets = [
    ["node", file],
    ["node", "--test", file],
  ];
  return Object.entries(PKG_SCRIPTS)
    .filter(([, command]) => {
      if (typeof command !== "string") return false;
      const { commands } = parseShellScript(command);
      return commands.some((parsed) =>
        targets.some((target) => isCommand(parsed, target)),
      );
    })
    .map(([name]) => name);
}

/** Every way a job may invoke this suite. @param {string} file */
function invocationsOf(file) {
  const targets = [
    ["node", file],
    ["node", "--test", file],
  ];
  for (const alias of aliasesFor(file)) {
    targets.push(["pnpm", alias], ["pnpm", "run", alias]);
  }
  return targets;
}

// ── external parsers ─────────────────────────────────────────────────────────

/**
 * The static import specifiers of an ES module, straight from V8's parser.
 * Nothing is executed and no text is matched, so a commented-out import (line
 * or block), an import inside a string or template literal, and an unreached
 * dynamic `import()` are all absent — correctly.
 *
 * @param {string} path
 */
function staticImports(path) {
  const program = `
const vm = require("node:vm");
const fs = require("node:fs");
// Node strips the shebang when it loads a file; vm.SourceTextModule does not.
const source = fs.readFileSync(process.argv[1], "utf8").replace(/^#![^\\n]*/, "");
process.stdout.write(
  JSON.stringify(new vm.SourceTextModule(source, { identifier: process.argv[1] }).dependencySpecifiers),
);
`;
  const out = execFileSync(
    process.execPath,
    ["--experimental-vm-modules", "--no-warnings", "-e", program, path],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out);
}

/**
 * Run the gate's own `case` statement over each path and report how it
 * classifies them. bash parses its own source and does its own pattern
 * matching, so a commented-out entry, an entry moved to a different arm, and
 * an arm whose body changed all show up as a different classification.
 *
 * @param {string[]} paths
 * @returns {Map<string, string>}
 */
function gateClassifications(paths) {
  const header = "\nclassify_root_package_json_changes() {\n";
  const first = GATE.indexOf(header);
  assert.ok(
    first >= 0,
    `classify_root_package_json_changes is gone from ${GATE_PATH}`,
  );
  assert.equal(
    GATE.lastIndexOf(header),
    first,
    "classify_root_package_json_changes is defined more than once — this probe would read the wrong one",
  );
  const rest = GATE.slice(first + 1);
  const end = rest.indexOf("\n}\n");
  assert.ok(
    end > 0,
    "classify_root_package_json_changes has no closing brace at column 0",
  );
  const fnSource = rest.slice(0, end + 3);

  // `json_change_paths` reads git; the probe feeds the function one synthetic
  // change path instead. Process substitution forks the shell, so the loop
  // variable is visible inside the stub.
  const program = `
set -uo pipefail
${fnSource}
json_change_paths() { printf '%s\\n' "$__probe_path"; }
declare -F classify_root_package_json_changes > /dev/null || { echo "__probe_broken__"; exit 3; }
for __probe_path in "$@"; do
  printf '%s\\t%s\\n' "$__probe_path" "$(classify_root_package_json_changes)"
done
`;
  const out = execFileSync("bash", ["-s", "--", ...paths], {
    input: program,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const classifications = new Map();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [path, verdict] = line.split("\t");
    classifications.set(path, verdict);
  }
  return classifications;
}

/**
 * The exact commands check-agent-quality-gate-package-scripts.sh pins, read
 * from the validator itself: it is run against a package.json with no scripts,
 * so it reports every pin it enforces, with the command it demands.
 *
 * This reads enforcement, not declaration. A commented-out pin produces no
 * line — and neither would a pin the validator declared but never checked.
 *
 * @returns {Map<string, string>}
 */
function validatorPins() {
  const dir = mkdtempSync(join(tmpdir(), "sentry-pin-probe-"));
  let output;
  try {
    writeFileSync(join(dir, "package.json"), '{"scripts":{}}\n');
    try {
      execFileSync("bash", [VALIDATOR_PATH], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      output = "";
    } catch (error) {
      // A pin that is not satisfied is reported and exits non-zero, which is
      // the whole point of the probe.
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const pins = new Map();
  for (const line of output.split("\n")) {
    const match = /^package\.json scripts\.(\S+) must be (.+)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    pins.set(match[1], JSON.parse(match[2]));
  }
  return pins;
}

// ── invariants ───────────────────────────────────────────────────────────────

test("the enumeration found the Sentry suites at all", () => {
  // A rename or a moved directory must fail loudly rather than vacuously pass
  // every assertion below.
  assert.ok(
    SENTRY_SUITES.length >= 8,
    `expected at least 8 scripts/sentry-*.test.mjs suites, found ${SENTRY_SUITES.length}`,
  );
});

test("the ci.yml jobs this file trusts still run and still fail on failure", () => {
  assert.deepEqual(
    workflowBlockers(),
    [],
    "ci.yml's workflow-scope settings changed",
  );
  for (const name of TRUSTED_JOBS.keys()) {
    assert.deepEqual(
      jobBlockers(name),
      [],
      `the \`${name}\` job can no longer be trusted to run its steps and fail the workflow`,
    );
  }
});

test("the `ci` sentinel still requires those jobs", () => {
  // The suites only guard anything while a red `scripts` job blocks the merge.
  // Dropping it from the sentinel's `needs`, or listing it as an allowed
  // failure, would leave every step in place and every assertion inert.
  const sentinel = ciJob("ci");
  const required = needsList(sentinel.needs);
  for (const name of TRUSTED_JOBS.keys()) {
    assert.ok(
      required.includes(name),
      `the \`ci\` sentinel no longer needs \`${name}\`, so that job's failure would not block a merge`,
    );
  }
  assert.ok(
    sentinel["continue-on-error"] === undefined ||
      sentinel["continue-on-error"] === false,
    "the `ci` sentinel sets `continue-on-error`, so it reports success whatever its jobs did",
  );

  const allsGreen = (sentinel.steps ?? []).filter(
    (step) =>
      isPlainObject(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("re-actors/alls-green@"),
  );
  assert.equal(
    allsGreen.length,
    1,
    `the \`ci\` sentinel has ${allsGreen.length} alls-green steps — it must have exactly the one that reads every job's result`,
  );
  const [gate] = allsGreen;
  assert.deepEqual(
    stepBlockers(gate),
    [],
    "the `ci` sentinel's alls-green step may not run or may not fail, so a red job would not block a merge",
  );
  assert.equal(
    gate.with?.jobs,
    "${{ toJSON(needs) }}",
    `the alls-green step reads \`${gate.with?.jobs}\` instead of every job it needs`,
  );
  const tolerated = String(gate.with?.["allowed-failures"] ?? "")
    .split(",")
    .map((entry) => entry.trim());
  for (const name of TRUSTED_JOBS.keys()) {
    assert.ok(
      !tolerated.includes(name),
      `the \`ci\` sentinel tolerates a failing \`${name}\` job via \`allowed-failures\``,
    );
  }
});

test("ci.yml still runs on pull requests to main", () => {
  // Everything below assumes these jobs run before a merge.
  const triggers = CI.on;
  assert.ok(isPlainObject(triggers), "ci.yml declares no `on:` triggers");
  assert.ok(
    "pull_request" in triggers,
    "ci.yml no longer runs on `pull_request`, so none of these jobs gate a merge",
  );
  const trigger = triggers.pull_request ?? {};
  const branches = trigger.branches;
  assert.ok(
    branches === undefined || branches.includes("main"),
    `ci.yml's \`pull_request\` trigger no longer covers main: ${JSON.stringify(branches)}`,
  );
  // A `paths:`/`paths-ignore:` on the trigger skips the WORKFLOW, not just a
  // job, so no `allowed-skips` reasoning applies and nothing here would run.
  assert.equal(
    trigger.paths ?? trigger["paths-ignore"],
    undefined,
    "ci.yml's `pull_request` trigger is path-scoped, so a PR outside those paths runs no job at all",
  );
  // Default types are opened/synchronize/reopened. Narrowing them would stop
  // the workflow re-running on a push to the branch.
  const types = trigger.types;
  assert.ok(
    types === undefined ||
      (types.includes("opened") &&
        types.includes("synchronize") &&
        types.includes("reopened")),
    `ci.yml's \`pull_request\` trigger narrows \`types\` to ${JSON.stringify(types)}, so pushes may not re-run it`,
  );
});

test("every Sentry suite is invoked by the ci.yml `scripts` job", () => {
  const commands = provenCommands("scripts");
  const missing = SENTRY_SUITES.filter(
    (file) =>
      !RUN_BY_ANOTHER_JOB.has(file) &&
      !invocationsOf(file).some((target) => runsCommand(commands, target)),
  );
  const detail = missing
    .flatMap((file) =>
      nearMisses("scripts", invocationsOf(file)).map(
        (note) => `  ${file}: ${note}`,
      ),
    )
    .join("\n");
  assert.deepEqual(
    missing,
    [],
    `these Sentry suites run nowhere in CI: ${missing.join(", ")}.\n${detail}\n` +
      "Add a step to the `scripts` job in .github/workflows/ci.yml that runs the " +
      "suite as its whole command, or add an entry to RUN_BY_ANOTHER_JOB naming " +
      "the job that does run it.",
  );
});

test("the exemption for sentry-provider-contract still holds", () => {
  for (const [file, route] of RUN_BY_ANOTHER_JOB) {
    assert.ok(
      SENTRY_SUITES.includes(file),
      `RUN_BY_ANOTHER_JOB names ${file}, which no longer exists — drop the entry`,
    );
    assert.equal(
      file,
      "scripts/sentry-provider-contract.test.mjs",
      `unproven exemption for ${file} (${route}) — extend this test to re-prove its route`,
    );

    // Half one: tf-stacks.test.mjs really imports it.
    const imports = staticImports(join(SCRIPTS_DIR, "tf-stacks.test.mjs"));
    assert.ok(
      imports.includes("./sentry-provider-contract.test.mjs"),
      `${file} is exempted because tf-stacks.test.mjs imports it, but its static ` +
        `imports are ${JSON.stringify(imports)}`,
    );

    // Half two: an unconditional job really runs tf-stacks.test.mjs.
    const owner = "production-infra-contract";
    const targets = invocationsOf("scripts/tf-stacks.test.mjs");
    assert.ok(
      targets.length > 2,
      "no package.json alias resolves to scripts/tf-stacks.test.mjs, so `pnpm tf:test` proves nothing",
    );
    const commands = provenCommands(owner);
    assert.ok(
      targets.some((target) => runsCommand(commands, target)),
      `${file} is exempted because the \`${owner}\` job runs tf-stacks.test.mjs, but no ` +
        `step there does: ${nearMisses(owner, targets).join("; ") || "no step mentions it"}`,
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
    (alias) => !SENTRY_SUITES.some((file) => aliasesFor(file).includes(alias)),
  );
  assert.deepEqual(
    unresolved,
    [],
    "these sentry:*:test scripts do not run a scripts/sentry-*.test.mjs file as " +
      `their whole command, so the CI-coverage assertion above cannot see them: ${unresolved.join(", ")}`,
  );
});

test("the local gate's tooling allowlist trusts every sentry:* script", () => {
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();

  // Two controls prove the probe is live before its verdicts are believed. A
  // silent probe would pass this test by classifying nothing.
  const trustedControl = "/scripts/tf:test";
  const untrustedControl = "/scripts/__not_an_allowlisted_alias__";
  const verdicts = gateClassifications([
    trustedControl,
    untrustedControl,
    ...sentryScripts.map((name) => `/scripts/${name}`),
  ]);
  assert.equal(
    verdicts.get(trustedControl),
    "root-tooling-scripts",
    "the allowlist probe cannot reproduce a known-trusted alias — the probe is broken, not the allowlist",
  );
  assert.equal(
    verdicts.get(untrustedControl),
    "package-scripts",
    "the allowlist probe trusts an alias that is not listed — it is matching the wrong `case` arm",
  );

  const missing = sentryScripts.filter(
    (name) => verdicts.get(`/scripts/${name}`) !== "root-tooling-scripts",
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

test("every sentry:* script the gate trusts is pinned to an exact command", () => {
  // Allowlisting an alias TRUSTS it: `agent:quality-gate --run` will execute it
  // without `--allow-package-script-changes`. That trust is only safe while
  // check-agent-quality-gate-package-scripts.sh pins the alias to an exact
  // command — otherwise appending `&& <anything>` to a trusted script runs it.
  // The two lists drifted apart before this assertion existed: 13 aliases were
  // trusted and 4 pinned.
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();
  const pins = validatorPins();

  // The probe reads the validator's own report. If its message format changed,
  // this control fails instead of every pin silently reading as absent.
  assert.equal(
    pins.get("tf:test"),
    "node scripts/tf-stacks.test.mjs",
    `the pin probe could not read ${VALIDATOR_PATH}'s report (${pins.size} pins parsed) — ` +
      "the probe is broken, not the pins",
  );

  const unpinned = sentryScripts.filter((name) => !pins.has(name));
  assert.deepEqual(
    unpinned,
    [],
    "these sentry:* scripts are trusted by classify_root_package_json_changes " +
      "but not pinned to an exact command in " +
      `check-agent-quality-gate-package-scripts.sh: ${unpinned.join(", ")}. ` +
      "A trusted alias whose command is not pinned can gain an appended " +
      "command that the gate then runs unprompted.",
  );

  // The validator itself is not wired into CI — only into the local gate — so
  // the sentry subset is re-checked here.
  const drifted = sentryScripts.filter(
    (name) => pins.get(name) !== PKG_SCRIPTS[name],
  );
  assert.deepEqual(
    drifted,
    [],
    `these sentry:* scripts no longer match their pin: ${drifted
      .map(
        (name) =>
          `${name} is ${JSON.stringify(PKG_SCRIPTS[name])}, pinned as ${JSON.stringify(pins.get(name))}`,
      )
      .join("; ")}`,
  );
});

test("the `scripts` job stays reachable from the paths its suites guard", () => {
  // Steps existing in the job is not enough. The job is path-gated, and the
  // `ci` sentinel lists it under `allowed-skips`, so if the filter loses a
  // path, a PR touching only that path skips the whole job and every suite in
  // it — silently, and this file would not run to complain either.
  //
  // The whole chain is followed from the parsed workflow: the job's `if:`
  // names an output of `changes`, that output names a step, that step's
  // `filters` value is an inner YAML document, and the key it defines is a
  // list of paths.
  const guard = TRUSTED_JOBS.get("scripts");
  const gate =
    /^\s*(?:\$\{\{\s*)?needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*==\s*'true'\s*(?:\}\})?\s*$/.exec(
      guard,
    );
  assert.ok(
    gate,
    `the \`scripts\` job guard \`${guard}\` is not a form this test can follow — extend the grammar and re-prove it`,
  );
  const [, gateJob, outputName] = gate;

  const producer = ciJob(gateJob);
  const expression = producer.outputs?.[outputName];
  assert.ok(
    typeof expression === "string",
    `the \`${gateJob}\` job declares no \`${outputName}\` output, so the \`scripts\` job's guard is never true`,
  );
  const wired =
    /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(
      expression.trim(),
    );
  assert.ok(
    wired,
    `\`${gateJob}.outputs.${outputName}\` is \`${expression}\`, which this test cannot trace to a step`,
  );
  const [, stepId, filterKey] = wired;

  const filterStep = (producer.steps ?? []).find(
    (step) => isPlainObject(step) && step.id === stepId,
  );
  assert.ok(
    filterStep,
    `the \`${gateJob}\` job has no step with \`id: ${stepId}\``,
  );
  assert.ok(
    typeof filterStep.uses === "string" &&
      filterStep.uses.startsWith("dorny/paths-filter@"),
    `step \`${stepId}\` is \`${filterStep.uses}\`, not the paths filter this test knows how to read`,
  );
  assert.deepEqual(
    stepBlockers(filterStep),
    [],
    `step \`${stepId}\` may not run, so \`${outputName}\` may be empty and the \`scripts\` job would skip`,
  );
  // `base:`/`ref:` change what the filter diffs against — `base: HEAD` reports
  // no changed files and every output goes false. Only `filters:` is proven.
  assert.deepEqual(
    Object.keys(filterStep.with ?? {}),
    ["filters"],
    `step \`${stepId}\` passes inputs beyond \`filters:\`, which can change what it compares`,
  );

  // The value is a YAML string that itself holds a YAML document.
  const filters = load(filterStep.with?.filters, { schema: CORE_SCHEMA });
  assert.ok(
    isPlainObject(filters),
    `step \`${stepId}\` has no parsable \`filters:\` document`,
  );
  const paths = filters[filterKey];
  assert.ok(
    Array.isArray(paths),
    `the \`${filterKey}\` filter is ${JSON.stringify(paths)}, not a list of paths`,
  );

  const dropped = REQUIRED_ROOT_SCRIPT_PATHS.filter(
    (required) => !paths.includes(required),
  );
  assert.deepEqual(
    dropped,
    [],
    `the \`${filterKey}\` paths filter no longer lists ${dropped.map((p) => `\`${p}\``).join(", ")}, ` +
      "so a PR touching only those files skips the `scripts` job and every Sentry suite in it",
  );
});

test("this check itself runs in the ci.yml `scripts` job", () => {
  // Without this, the meta-check could be dropped from CI and every invariant
  // above would go quiet.
  const commands = provenCommands("scripts");
  assert.ok(
    runsCommand(commands, ["node", SELF]),
    `the \`scripts\` job must run \`node ${SELF}\` as a whole step command: ` +
      `${nearMisses("scripts", [["node", SELF]]).join("; ") || "no step mentions it"}`,
  );
});
