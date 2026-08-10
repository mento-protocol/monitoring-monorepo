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

  // Only a trusted job's own steps run alongside its suites; a needed job runs
  // on a separate runner, so its environment writes cannot reach here. Scan the
  // trusted job itself, every step of it, for the imperative env-mutation
  // vector the declarative `env:` checks above cannot see.
  if (trustedJobs.has(name)) {
    blockers.push(...envMutationBlockers(job.steps, `\`${name}\``));
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
 * A `run:` line writing one of the runner's environment files. `>> $GITHUB_ENV`
 * sets a variable for every LATER step in the job, and `>> $GITHUB_PATH`
 * prepends a directory to `PATH` for them — the same reach as a job-level
 * `env:`, which this file rejects, but imperative and unparsable, so the
 * declarative `env:` checks never see it. `NODE_OPTIONS=--import=…` written this
 * way preloads a module into every later `node`/`pnpm`; a `$GITHUB_PATH` shim
 * dir shadows `pnpm` itself.
 */
const ENV_FILE_WRITE = /\b(GITHUB_ENV|GITHUB_PATH)\b/;

/**
 * Steps in a trusted job that mutate the runner environment for later steps.
 * Unlike stepBlockers (consulted only for the step that RUNS a suite), this
 * judges EVERY step: a step that sabotages the suites rather than invoking them
 * is never a "proven command", so it would otherwise contribute no blocker.
 *
 * @param {unknown} steps
 * @param {string} label the job or action the steps belong to
 */
export function envMutationBlockers(steps, label) {
  const blockers = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!isPlainObject(step) || typeof step.run !== "string") continue;
    if (ENV_FILE_WRITE.test(step.run)) {
      blockers.push(
        `${label} has a step (\`${step.name ?? step.run.trim().split("\n")[0]}\`) that writes ` +
          "`$GITHUB_ENV`/`$GITHUB_PATH`, which sets an environment variable or PATH entry for every " +
          "later step — the same reach as a job-level `env:`, which this file rejects",
      );
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
    const parsed = parseShellScript(step.run).commands;
    // A step proves a command only when that command is the WHOLE step. A
    // sibling bare-word line can rebind the target without being a shell
    // keyword: `cd <dir>` moves which package.json `pnpm <alias>` resolves (the
    // shell twin of the `working-directory:` stepBlockers already rejects), a
    // bare `PATH=…`/`hash -p …`/`NAME=…` shadows the binary, `cp /dev/null
    // <suite>` truncates the suite file. `runsCommand` only asks whether the
    // target appears among a step's commands, so any of these passes while the
    // suite never runs. No blacklist closes this — `cp` is an ordinary command
    // — so the rule is the same one `commandRunsOnly` applies to package
    // scripts: exactly one command, or the step proves nothing.
    if (parsed.length !== 1) continue;
    commands.push(parsed[0]);
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
    } else if (commands.length > 1) {
      notes.push(
        `step \`${step.name ?? step.run}\`: runs ${commands.length} commands; a suite must be the ` +
          "step's whole command, or a sibling line can rebind it (`cd`, `PATH=`, `cp /dev/null <suite>`)",
      );
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
 * Read an action input by name the way the runner does: `with:` keys are
 * matched case-insensitively and the last one wins, so `JOBS:` silently
 * overrides `jobs:`. An exact-case JS property read (`with.jobs`) would see the
 * decoy value the runner never uses. Returns the effective value and the set of
 * keys that collided, so a caller can reject the ambiguity outright.
 *
 * @param {Record<string, unknown> | undefined} withMap
 * @param {string} name
 */
export function withInput(withMap, name) {
  const hits = Object.entries(withMap ?? {}).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return {
    value: hits.length > 0 ? hits[hits.length - 1][1] : undefined,
    collidingKeys: hits.length > 1 ? hits.map(([key]) => key) : [],
  };
}

/**
 * Parse an alls-green list input the way the action does: `json.loads` first,
 * comma-split only as a fallback. `allowed-failures: '["scripts"]'` is a real
 * one-element list to the action and would be one opaque token to a comma-only
 * split, so a comma-only reader sees no tolerated job while the action tolerates
 * `scripts`. A value that parses as JSON but is not an array is not a list the
 * action iterates meaningfully; treat it as one opaque token and fail closed.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseActionList(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    }
    return [text];
  } catch {
    return text
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
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

  // The required status context is matched by check-run NAME, not by the YAML
  // key `ci`. A job keyed `ci` but named something else no longer publishes the
  // `ci` context the ruleset requires — merges then wait on a context that
  // never reports, or a decoy job elsewhere named `ci` satisfies it. Bind the
  // sentinel to the identity that makes it required. `contextOwnershipBlockers`
  // (asserted in the entry point over every workflow) proves no other job
  // claims the name.
  const sentinelName = sentinel.name ?? "ci";
  if (sentinelName !== "ci") {
    blockers.push(
      `the \`ci\` sentinel job publishes its check run as \`${sentinelName}\`, not \`ci\` — ` +
        "the branch ruleset requires the context `ci`, which is matched by check-run name",
    );
  }

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
  const jobsInput = withInput(gate.with, "jobs");
  if (jobsInput.collidingKeys.length > 0) {
    blockers.push(
      `the alls-green step passes \`jobs\` under case-variant keys ${JSON.stringify(jobsInput.collidingKeys)}; ` +
        "the runner matches `with:` keys case-insensitively and the last wins, so the decoy overrides the real value",
    );
  }
  if (jobsInput.value !== "${{ toJSON(needs) }}") {
    blockers.push(
      `the alls-green step reads \`${jobsInput.value}\` instead of every job it needs`,
    );
  }

  // Parse `allowed-failures` exactly as the action does (JSON first, comma
  // fallback), read through the case-insensitive helper, and reject it whenever
  // it names anything at all. The real sentinel has no `allowed-failures`, so
  // any non-empty value is a regression: a name here excludes that job from the
  // `result == 'success'` requirement in every state, which lets a red
  // `scripts` (all the Sentry suites) or a red `production-infra-contract`
  // merge behind a green `ci`. `changes` gates whether the path-filtered jobs
  // run at all, so tolerating its failure is just as fatal — hence "any name",
  // not only the trusted ones.
  const failuresInput = withInput(gate.with, "allowed-failures");
  if (failuresInput.collidingKeys.length > 0) {
    blockers.push(
      `the alls-green step passes \`allowed-failures\` under case-variant keys ${JSON.stringify(failuresInput.collidingKeys)}`,
    );
  }
  const tolerated = parseActionList(failuresInput.value);
  if (tolerated.length > 0) {
    blockers.push(
      `the \`ci\` sentinel sets \`allowed-failures\` (${JSON.stringify(tolerated)}); no job may be tolerated as a ` +
        "failure — a red trusted job, or a red `changes`, must turn the required `ci` context red",
    );
  }
  return blockers;
}

/**
 * The check-run name a job publishes is its `name:`, defaulting to its key. The
 * required `ci` status context is matched by that name across every workflow,
 * so the guarantee that a red `scripts` reaches the merge gate holds only while
 * exactly one job — the real sentinel — publishes the name `ci`. Rename the
 * sentinel and give the name to a trivial always-green job in another workflow
 * and the required context resolves to the decoy.
 *
 * @param {Array<{ path: string, workflow: Record<string, any> }>} workflows
 * @param {string} context the required check-run name, e.g. `ci`
 * @param {string} owner the `path#jobKey` that must be its sole producer
 */
export function contextOwnershipBlockers(workflows, context, owner) {
  const owners = [];
  for (const { path, workflow } of workflows) {
    if (!isPlainObject(workflow?.jobs)) continue;
    for (const [key, job] of Object.entries(workflow.jobs)) {
      if (!isPlainObject(job)) continue;
      // A reusable-workflow job (`uses:`) publishes its own called jobs' check
      // runs, not one named after this key, so it cannot claim the context.
      if (typeof job.uses === "string") continue;
      const name = typeof job.name === "string" ? job.name : key;
      if (name === context) owners.push(`${path}#${key}`);
    }
  }
  if (owners.length === 1 && owners[0] === owner) return [];
  return [
    `the required \`${context}\` check-run name is published by ${owners.length} job(s) ` +
      `(${owners.join(", ") || "none"}); exactly one — ${owner} — may, or the required context can resolve to a decoy`,
  ];
}

/**
 * Blockers when a job invokes a trusted `pnpm <alias>` before validating that
 * alias's pin. The pins are what make a trusted alias safe: without them a
 * drifted `"sentry:x:test": "node scripts/x.test.mjs && curl evil"` runs its
 * appended command. The meta-check re-checks the pins, but it runs last, so an
 * earlier alias step has already run the appended command. The local gate runs
 * the pin validator first; CI must too, so a drift fails fast before any
 * trusted alias executes.
 *
 * @param {Record<string, any>} workflow
 * @param {string} name the job whose step order is judged
 * @param {string[]} validatorTarget the pin validator command, matched whole
 * @param {string[][]} aliasTargets the trusted `pnpm <alias>` invocations to guard
 */
export function pinValidationOrderBlockers(
  workflow,
  name,
  validatorTarget,
  aliasTargets,
) {
  const steps = ciJob(workflow, name).steps ?? [];
  const firstProvenIndex = (target) => {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!isPlainObject(step) || typeof step.run !== "string") continue;
      if (stepBlockers(step).length > 0) continue;
      const parsed = parseShellScript(step.run).commands;
      if (parsed.length === 1 && isCommand(parsed[0], target)) return index;
    }
    return -1;
  };

  const validatorIndex = firstProvenIndex(validatorTarget);
  if (validatorIndex < 0) {
    return [
      `the \`${name}\` job never runs \`${validatorTarget.join(" ")}\` as a whole step command, ` +
        "so it invokes trusted aliases without validating their pins first",
    ];
  }
  const blockers = [];
  for (const target of aliasTargets) {
    const at = firstProvenIndex(target);
    if (at >= 0 && at < validatorIndex) {
      blockers.push(
        `the \`${name}\` job runs \`${target.join(" ")}\` (step ${at}) before the pin validator ` +
          `(step ${validatorIndex}) — a drifted alias would run its appended command before the pins are checked`,
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
  if (branches !== undefined) {
    // A `branches:` list may itself carry negations: `branches: [main, "!main"]`
    // lists main yet excludes it, because a later negative pattern overrides an
    // earlier positive for the same ref. `includes("main")` reads that as
    // covered. This repo's trigger uses positive patterns only, so any `!`
    // entry is rejected outright — no false positive, and it is the form that
    // can exclude main while `branches` literally names it.
    const list = Array.isArray(branches) ? branches : [branches];
    const negated = list.filter(
      (entry) => typeof entry === "string" && entry.startsWith("!"),
    );
    if (negated.length > 0) {
      blockers.push(
        `ci.yml's \`pull_request\` trigger \`branches:\` uses negative patterns ${JSON.stringify(negated)}, ` +
          "which can exclude main even while it is listed",
      );
    } else if (!list.includes("main")) {
      blockers.push(
        `ci.yml's \`pull_request\` trigger no longer covers main: ${JSON.stringify(branches)}`,
      );
    }
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

  // dorny/paths-filter globs may be negated with a leading `!`, and a negation
  // cancels an earlier positive for the files it matches: `["scripts/**/*.mjs",
  // "!scripts/**"]` still literally lists the required path, so `includes()`
  // reads it as covered while edits under scripts/ no longer trigger the job.
  // This repo's filters use positive rules only, so any `!` entry is rejected
  // outright rather than matched against each required path.
  const negated = paths.filter(
    (entry) => typeof entry === "string" && entry.startsWith("!"),
  );
  if (negated.length > 0) {
    return [
      `the \`${filterKey}\` filter uses negative patterns ${JSON.stringify(negated)}, ` +
        "which can cancel a required path even when it is listed",
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
