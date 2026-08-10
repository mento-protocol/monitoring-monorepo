/**
 * The pure predicates behind scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * Nothing here reads a file, spawns a process, or closes over repo state:
 * every function takes the structure it judges as an argument. That is what
 * lets the entry point run each check twice — once against the real ci.yml and
 * package.json, and once against a `structuredClone` with a single field
 * broken. A check that passes on the real workflow has proven only that it
 * accepts; the mutation probes are what prove it rejects.
 *
 * The file reads, the external-process probes, the repo-specific policy
 * constants, and every `test()` stay in the entry point next door.
 */

import assert from "node:assert/strict";
import { CORE_SCHEMA, load } from "js-yaml";

/**
 * Env names proven not to change any suite's behaviour. Empty on purpose: an
 * `env:` on a job or an invoking step can flip a suite into a no-op, and this
 * file cannot tell which. Add a name here only with that proof.
 */
const PROVEN_INERT_ENV = new Set();

/** @param {unknown} value */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A paths-filter glob as a regular expression. Only the four forms this repo's
 * filter uses need to be right — `**` across directories, `*` within one, and
 * literal names — so this is a coverage check on our own constant, not a
 * general glob engine.
 *
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const character = glob[i];
    if (character === "*") {
      if (glob[i + 1] === "*" && glob[i + 2] === "/") {
        pattern += "(?:[^/]*/)*";
        i += 2;
      } else if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(character)) {
      pattern += `\\${character}`;
    } else {
      pattern += character;
    }
  }
  return new RegExp(`^${pattern}$`);
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
export function runsCommand(commands, target) {
  return commands.some((command) => isCommand(command, target));
}

// ── ci.yml structure ─────────────────────────────────────────────────────────

/**
 * Every predicate below takes the parsed workflow as its first argument rather
 * than closing over `CI`. That is what lets a mutation probe run the real check
 * against a `structuredClone` of the workflow with one field changed, proving
 * the check rejects it — without writing a fixture workflow that would drift
 * from the real one.
 */

/**
 * Workflow-scope settings that reach into every job: a `defaults.run` can move
 * the working directory or swap the shell out from under a step, and a
 * workflow-level `env:` reaches the suites the same way a step-level one does.
 *
 * @param {Record<string, any>} workflow
 */
export function workflowBlockers(workflow) {
  const blockers = [];
  if (workflow.defaults !== undefined) {
    blockers.push(
      "ci.yml declares workflow-level `defaults:`, which can redirect every job's shell or working directory",
    );
  }
  for (const key of Object.keys(workflow.env ?? {})) {
    if (!PROVEN_INERT_ENV.has(key)) {
      blockers.push(
        `ci.yml sets workflow-level \`env.${key}\`, which may change what a suite does`,
      );
    }
  }
  return blockers;
}

/**
 * @param {Record<string, any>} workflow
 * @param {string} name
 */
function ciJob(workflow, name) {
  assert.ok(isPlainObject(workflow?.jobs), "ci.yml declares no `jobs:` map");
  const job = workflow.jobs[name];
  assert.ok(isPlainObject(job), `the \`${name}\` job was not found in ci.yml`);
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
 * @param {Record<string, any>} workflow
 * @param {string} name
 * @param {Map<string, string | null>} trustedJobs
 * @param {Set<string>} [seen]
 */
export function jobBlockers(workflow, name, trustedJobs, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const job = ciJob(workflow, name);
  const blockers = [];

  const allowedIf = trustedJobs.has(name) ? trustedJobs.get(name) : null;
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
    if (!isPlainObject(workflow.jobs?.[dependency])) {
      blockers.push(
        `\`${name}\` needs \`${dependency}\`, which does not exist — the job can never start`,
      );
      continue;
    }
    blockers.push(...jobBlockers(workflow, dependency, trustedJobs, seen));
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
 * @param {Record<string, any>} workflow
 * @param {string} name
 */
export function provenCommands(workflow, name) {
  const commands = [];
  for (const step of ciJob(workflow, name).steps ?? []) {
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
 * @param {Record<string, any>} workflow
 * @param {string} name
 * @param {string[][]} targets
 */
export function nearMisses(workflow, name, targets) {
  const notes = [];
  for (const step of ciJob(workflow, name).steps ?? []) {
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

/**
 * Everything that stops the `ci` sentinel from turning a red trusted job into a
 * red required check.
 *
 * The suites only guard anything while a red `scripts` job blocks the merge.
 * Dropping it from the sentinel's `needs`, listing it as an allowed failure, or
 * letting the sentinel itself skip would leave every step in place and every
 * assertion inert.
 *
 * @param {Record<string, any>} workflow
 * @param {Iterable<string>} trustedNames
 */
export function sentinelBlockers(workflow, trustedNames) {
  const sentinel = ciJob(workflow, "ci");
  const names = [...trustedNames];
  const blockers = [];

  // A skipped job's check run reports success, so a sentinel that can skip
  // stops propagating a red `scripts` job to the required `ci` context. Its
  // fourteen path-gated dependencies make `always()` load-bearing, not
  // decorative: without it the sentinel skips on any PR that skips one of them.
  if (sentinel.if !== "always()") {
    blockers.push(
      `the \`ci\` sentinel has \`if: ${sentinel.if}\` — it must be \`always()\`, because ` +
        "a skipped job reports success and the required `ci` context would stop " +
        "propagating a red `scripts` job",
    );
  }

  const required = needsList(sentinel.needs);
  for (const name of names) {
    if (!required.includes(name)) {
      blockers.push(
        `the \`ci\` sentinel no longer needs \`${name}\`, so that job's failure would not block a merge`,
      );
    }
  }
  if (
    sentinel["continue-on-error"] !== undefined &&
    sentinel["continue-on-error"] !== false
  ) {
    blockers.push(
      "the `ci` sentinel sets `continue-on-error`, so it reports success whatever its jobs did",
    );
  }

  const allsGreen = (sentinel.steps ?? []).filter(
    (step) =>
      isPlainObject(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("re-actors/alls-green@"),
  );
  if (allsGreen.length !== 1) {
    blockers.push(
      `the \`ci\` sentinel has ${allsGreen.length} alls-green steps — it must have exactly the one that reads every job's result`,
    );
    return blockers;
  }

  const [gate] = allsGreen;
  for (const blocker of stepBlockers(gate)) {
    blockers.push(
      `the \`ci\` sentinel's alls-green step, the one step that turns a red job into a red \`ci\`, has ${blocker}`,
    );
  }
  if (gate.with?.jobs !== "${{ toJSON(needs) }}") {
    blockers.push(
      `the alls-green step reads \`${gate.with?.jobs}\` instead of every job it needs`,
    );
  }
  const tolerated = String(gate.with?.["allowed-failures"] ?? "")
    .split(",")
    .map((entry) => entry.trim());
  for (const name of names) {
    if (tolerated.includes(name)) {
      blockers.push(
        `the \`ci\` sentinel tolerates a failing \`${name}\` job via \`allowed-failures\``,
      );
    }
  }
  return blockers;
}

/**
 * Everything that stops ci.yml from running on a pull request to main.
 * Everything else in this file assumes these jobs run before a merge.
 *
 * @param {Record<string, any>} workflow
 */
export function triggerBlockers(workflow) {
  const triggers = workflow.on;
  if (!isPlainObject(triggers)) return ["ci.yml declares no `on:` triggers"];
  if (!("pull_request" in triggers)) {
    return [
      "ci.yml no longer runs on `pull_request`, so none of these jobs gate a merge",
    ];
  }

  const trigger = triggers.pull_request ?? {};
  const blockers = [];

  // Absent both filters the trigger covers every base branch, main included,
  // so `undefined` is correct here. A NEGATIVE filter is not: GitHub rejects a
  // trigger that sets both keys, so rejecting `branches-ignore` outright has no
  // false positive, and it is the only form that can exclude main while
  // `branches` reads as unset.
  const branches = trigger.branches;
  if (!(branches === undefined || branches.includes("main"))) {
    blockers.push(
      `ci.yml's \`pull_request\` trigger no longer covers main: ${JSON.stringify(branches)}`,
    );
  }
  if (trigger["branches-ignore"] !== undefined) {
    blockers.push(
      `ci.yml's \`pull_request\` trigger uses \`branches-ignore: ${JSON.stringify(trigger["branches-ignore"])}\`, ` +
        "which can exclude main — the workflow would never run, and every affected PR " +
        "would wait forever on a required `ci` context that never reports",
    );
  }
  // A `paths:`/`paths-ignore:` on the trigger skips the WORKFLOW, not just a
  // job, so no `allowed-skips` reasoning applies and nothing here would run.
  if ((trigger.paths ?? trigger["paths-ignore"]) !== undefined) {
    blockers.push(
      "ci.yml's `pull_request` trigger is path-scoped, so a PR outside those paths runs no job at all",
    );
  }
  // Default types are opened/synchronize/reopened. Narrowing them would stop
  // the workflow re-running on a push to the branch.
  const types = trigger.types;
  if (
    !(
      types === undefined ||
      (types.includes("opened") &&
        types.includes("synchronize") &&
        types.includes("reopened"))
    )
  ) {
    blockers.push(
      `ci.yml's \`pull_request\` trigger narrows \`types\` to ${JSON.stringify(types)}, so pushes may not re-run it`,
    );
  }
  return blockers;
}

/**
 * Which of `required` the path filter behind `guard` no longer lists, or why
 * the chain from the guard to that filter could not be followed.
 *
 * Steps existing in a job is not enough. The `scripts` job is path-gated, and
 * the `ci` sentinel lists it under `allowed-skips`, so if the filter loses a
 * path, a PR touching only that path skips the whole job and every suite in it
 * — silently, and this file would not run to complain either.
 *
 * The whole chain is followed from the parsed workflow: the job's `if:` names
 * an output of a job, that output names a step, that step's `filters` value is
 * an inner YAML document, and the key it defines is a list of paths.
 *
 * @param {Record<string, any>} workflow
 * @param {string} guard the gated job's `if:` expression
 * @param {string[]} required
 */
export function requiredPathsMissing(workflow, guard, required) {
  const gate =
    /^\s*(?:\$\{\{\s*)?needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*==\s*'true'\s*(?:\}\})?\s*$/.exec(
      guard,
    );
  if (!gate) {
    return [
      `the \`scripts\` job guard \`${guard}\` is not a form this test can follow — extend the grammar and re-prove it`,
    ];
  }
  const [, gateJob, outputName] = gate;

  const producer = ciJob(workflow, gateJob);
  const expression = producer.outputs?.[outputName];
  if (typeof expression !== "string") {
    return [
      `the \`${gateJob}\` job declares no \`${outputName}\` output, so the \`scripts\` job's guard is never true`,
    ];
  }
  const wired =
    /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(
      expression.trim(),
    );
  if (!wired) {
    return [
      `\`${gateJob}.outputs.${outputName}\` is \`${expression}\`, which this test cannot trace to a step`,
    ];
  }
  const [, stepId, filterKey] = wired;

  const filterStep = (producer.steps ?? []).find(
    (step) => isPlainObject(step) && step.id === stepId,
  );
  if (!filterStep) {
    return [`the \`${gateJob}\` job has no step with \`id: ${stepId}\``];
  }
  if (
    typeof filterStep.uses !== "string" ||
    !filterStep.uses.startsWith("dorny/paths-filter@")
  ) {
    return [
      `step \`${stepId}\` is \`${filterStep.uses}\`, not the paths filter this test knows how to read`,
    ];
  }
  const stepIssues = stepBlockers(filterStep);
  if (stepIssues.length > 0) {
    return stepIssues.map(
      (blocker) =>
        `step \`${stepId}\` has ${blocker}, so \`${outputName}\` may be empty and the \`scripts\` job would skip`,
    );
  }
  // `base:`/`ref:` change what the filter diffs against — `base: HEAD` reports
  // no changed files and every output goes false. Only `filters:` is proven.
  const inputs = Object.keys(filterStep.with ?? {});
  if (inputs.length !== 1 || inputs[0] !== "filters") {
    return [
      `step \`${stepId}\` passes inputs beyond \`filters:\` (${JSON.stringify(inputs)}), which can change what it compares`,
    ];
  }

  // The value is a YAML string that itself holds a YAML document.
  const filters = load(filterStep.with?.filters, { schema: CORE_SCHEMA });
  if (!isPlainObject(filters)) {
    return [`step \`${stepId}\` has no parsable \`filters:\` document`];
  }
  const paths = filters[filterKey];
  if (!Array.isArray(paths)) {
    return [
      `the \`${filterKey}\` filter is ${JSON.stringify(paths)}, not a list of paths`,
    ];
  }

  return required.filter((entry) => !paths.includes(entry));
}

// ── package.json aliases ─────────────────────────────────────────────────────

/** The command forms that count as running `file`. @param {string} file */
export function suiteTargets(file) {
  return [
    ["node", file],
    ["node", "--test", file],
  ];
}

/**
 * Does this package-script command run one of `targets` and nothing else?
 *
 * Exactly one command, not "one of its commands": a package script is handed to
 * a shell WITHOUT `-e`, so in `"node scripts/x.test.mjs\ntrue"` the second line
 * decides the alias's exit status and the suite's failures are swallowed. The
 * invoking CI step's own `bash -e` does not reach inside the script it runs.
 *
 * @param {unknown} command
 * @param {string[][]} targets
 */
export function commandRunsOnly(command, targets) {
  if (typeof command !== "string") return false;
  const { commands } = parseShellScript(command);
  return (
    commands.length === 1 &&
    targets.some((target) => isCommand(commands[0], target))
  );
}

/**
 * The package.json aliases that actually run this suite file.
 *
 * The command is tokenized and matched whole, so
 * `"sentry:ingest:test": "echo scripts/x.mjs"`,
 * `"sentry:ingest:test": "node scripts/x.mjs || true"`, and
 * `"sentry:ingest:test": "node scripts/x.mjs\ntrue"` all fail to resolve — the
 * CI step would run, the suite would not.
 *
 * @param {Record<string, unknown>} scripts package.json's `scripts` map
 * @param {string} file repo-relative path, e.g. `scripts/sentry-x.test.mjs`
 */
export function aliasesFor(scripts, file) {
  const targets = suiteTargets(file);
  return Object.entries(scripts)
    .filter(([, command]) => commandRunsOnly(command, targets))
    .map(([name]) => name);
}

/**
 * Every way a job may invoke this suite.
 *
 * @param {Record<string, unknown>} scripts
 * @param {string} file
 */
export function invocationsOf(scripts, file) {
  const targets = suiteTargets(file);
  for (const alias of aliasesFor(scripts, file)) {
    targets.push(["pnpm", alias], ["pnpm", "run", alias]);
  }
  return targets;
}
