/**
 * The pure predicates behind scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs.
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
import {
  isCommand,
  parseShellScript,
  runsCommand,
} from "./check-sentry-suites-in-ci-core-commands.mjs";

// The command-grammar and alias predicates live in the sibling module to keep
// both files under the repo's line cap; re-export them so importers still reach
// every public name through this module.
export {
  aliasesFor,
  commandRunsOnly,
  invocationsOf,
  suiteTargets,
} from "./check-sentry-suites-in-ci-core-commands.mjs";
export { runsCommand };

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
 * @param {Map<string, string | null> | Iterable<string>} trustedJobs the
 *   trusted jobs mapped to the only `if:` each may carry (`null` = must run
 *   unconditionally). A bare iterable of names is accepted for callers that do
 *   not track guards, but then no `allowed-skips` requirement can be enforced.
 */
export function sentinelBlockers(workflow, trustedJobs) {
  const sentinel = ciJob(workflow, "ci");
  const trusted =
    trustedJobs instanceof Map
      ? trustedJobs
      : new Map([...trustedJobs].map((name) => [name, null]));
  const names = [...trusted.keys()];
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
  // fifteen path-gated dependencies make `always()` load-bearing, not
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
  const ordinaryCondition = "${{ !inputs.no_skip_audit }}";
  const auditCondition = "${{ inputs.no_skip_audit }}";
  const ordinaryGates = allsGreen.filter(
    (step) => step.if === undefined || step.if === ordinaryCondition,
  );
  const auditGates = allsGreen.filter((step) => step.if === auditCondition);
  const splitAudit =
    allsGreen.length === 2 &&
    ordinaryGates.length === 1 &&
    ordinaryGates[0].if === ordinaryCondition &&
    auditGates.length === 1;
  const unconditional =
    allsGreen.length === 1 &&
    ordinaryGates.length === 1 &&
    ordinaryGates[0].if === undefined;
  if (!unconditional && !splitAudit) {
    blockers.push(
      `the \`ci\` sentinel has an invalid alls-green split — it must have one ordinary gate, plus one mutually exclusive no-skip gate when audit mode exists`,
    );
    return blockers;
  }

  const [gate] = ordinaryGates;
  const ordinaryForBlocking =
    gate.if === ordinaryCondition ? { ...gate, if: undefined } : gate;
  for (const blocker of stepBlockers(ordinaryForBlocking)) {
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

  // alls-green has a second list input, `allowed-skips`, parsed the same way
  // (JSON first, comma fallback). It is not a coverage bypass — it tolerates a
  // SKIPPED result, never a FAILED one, so a red suite still reds `ci`. The
  // hazard is the mirror image: a path-gated trusted job (its `if:` is a paths
  // filter, so `trusted.get(name)` is non-null) reports "skipped" on every PR
  // outside that filter. alls-green treats a skip of a job NOT in
  // `allowed-skips` as a gate failure, so dropping such a job here turns the
  // required `ci` context red for every PR that legitimately skips it — and the
  // edit that drops it also touches paths that activate the filter, so the very
  // PR making the change runs the job and never sees the red. This is a
  // correctness/availability guard: require every path-gated trusted job to
  // stay listed. Read through the case-insensitive helper for the same reason
  // `jobs`/`allowed-failures` are.
  const skipsInput = withInput(gate.with, "allowed-skips");
  if (skipsInput.collidingKeys.length > 0) {
    blockers.push(
      `the alls-green step passes \`allowed-skips\` under case-variant keys ${JSON.stringify(skipsInput.collidingKeys)}; ` +
        "the runner matches `with:` keys case-insensitively and the last wins, so the decoy overrides the real value",
    );
  }
  const allowedSkips = new Set(parseActionList(skipsInput.value));
  for (const name of names) {
    if (trusted.get(name) != null && !allowedSkips.has(name)) {
      blockers.push(
        `the \`ci\` sentinel no longer lists path-gated \`${name}\` under \`allowed-skips\` ` +
          `(${JSON.stringify([...allowedSkips])}); a PR outside its paths filter would skip it, and ` +
          "alls-green turns an unlisted skip into a red required `ci` context — blocking every such merge",
      );
    }
  }
  return blockers;
}

/** Escape a literal string for embedding in a `RegExp`. */
function escapeRegExpLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Could a job `name:` — a template the runner substitutes `${{ }}` expressions
 * into before publishing the check run — produce `target`? Every expression is
 * over-approximated as an arbitrary string, so a `false` return PROVES the
 * published name can never be `target`, whatever the expressions evaluate to; a
 * name with no expression is proven distinct exactly when it differs literally.
 * This is what lets the ownership scan fail closed on a dynamic name it cannot
 * evaluate (`${{ 'ci' }}`) while still clearing a statically distinct one
 * (`Drift Plan (${{ matrix.id }})`).
 *
 * @param {string} template
 * @param {string} target
 */
function nameCouldEqual(template, target) {
  let pattern = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("${{", index);
    if (open < 0) {
      pattern += escapeRegExpLiteral(template.slice(index));
      break;
    }
    pattern += escapeRegExpLiteral(template.slice(index, open));
    const close = template.indexOf("}}", open + 3);
    pattern += "[\\s\\S]*";
    if (close < 0) break; // unterminated: the rest is inside the expression
    index = close + 2;
  }
  return new RegExp(`^${pattern}$`).test(target);
}

/**
 * The check-run name a job publishes is its `name:`, defaulting to its key. The
 * required `ci` status context is matched by that name across every workflow,
 * so the guarantee that a red `scripts` reaches the merge gate holds only while
 * exactly one job — the real sentinel — publishes the name `ci`. Rename the
 * sentinel and give the name to a trivial always-green job in another workflow
 * and the required context resolves to the decoy.
 *
 * A job key is a static YAML identifier, but an explicit `name:` may be a
 * `${{ }}` template the runner evaluates. This scan cannot evaluate it, so it
 * cannot prove such a name is not `context`. Any dynamic name whose literal
 * skeleton still admits `context` is rejected outright — a statically distinct
 * one (`Drift Plan (${{ matrix.id }})`) clears via `nameCouldEqual`. Without
 * this, a decoy `name: ${{ 'ci' }}` job publishes the required context while
 * this comparison reads its unevaluated text and never counts it.
 *
 * @param {Array<{ path: string, workflow: Record<string, any> }>} workflows
 * @param {string} context the required check-run name, e.g. `ci`
 * @param {string} owner the `path#jobKey` that must be its sole producer
 */
export function contextOwnershipBlockers(workflows, context, owner) {
  const owners = [];
  const ambiguous = [];
  for (const { path, workflow } of workflows) {
    if (!isPlainObject(workflow?.jobs)) continue;
    for (const [key, job] of Object.entries(workflow.jobs)) {
      if (!isPlainObject(job)) continue;
      // A reusable-workflow job (`uses:`) publishes its own called jobs' check
      // runs, not one named after this key, so it cannot claim the context.
      if (typeof job.uses === "string") continue;
      const declared = typeof job.name === "string" ? job.name : key;
      if (declared.includes("${{")) {
        if (nameCouldEqual(declared, context)) {
          ambiguous.push(`${path}#${key} (name: ${declared})`);
        }
        continue;
      }
      if (declared === context) owners.push(`${path}#${key}`);
    }
  }
  const blockers = [];
  if (ambiguous.length > 0) {
    blockers.push(
      `the required \`${context}\` check-run name may be claimed by ${ambiguous.length} job(s) with a ` +
        `\`\${{ }}\` name this scan cannot evaluate (${ambiguous.join(", ")}); give each a static name ` +
        `provably distinct from \`${context}\``,
    );
  }
  if (!(owners.length === 1 && owners[0] === owner)) {
    blockers.push(
      `the required \`${context}\` check-run name is published by ${owners.length} job(s) ` +
        `(${owners.join(", ") || "none"}); exactly one — ${owner} — may, or the required context can resolve to a decoy`,
    );
  }
  return blockers;
}

/**
 * Blockers when a job runs untrusted execution before validating it. The pin
 * validator (check-agent-quality-gate-package-scripts.mjs) is what makes the
 * job's trust safe: it pins each trusted alias to an exact command, so a drifted
 * `"docs:index": "node … && curl evil"` is rejected, and it rejects an
 * unsanctioned lifecycle hook a package-only PR adds. Both guarantees hold only
 * while the validator runs FIRST — before it, two surfaces would run unchecked:
 *
 *   - `installAction` (`pnpm install`) runs the root lifecycle hooks; a
 *     `postinstall` that truncates the suites and this validator would execute
 *     before validation (Codex 3754887736), so the validator must precede it.
 *   - a trusted `pnpm <alias>` step runs its (possibly drifted) command; the
 *     meta-check re-checks the pins but runs last, so an earlier alias would run
 *     an appended command before the pins are checked.
 *
 * @param {Record<string, any>} workflow
 * @param {string} name the job whose step order is judged
 * @param {string[]} validatorTarget the pin validator command, matched whole
 * @param {Set<string>} trustedAliases pinned alias names to guard
 * @param {string} installAction the local install action's `uses:` value
 */
export function pinValidationOrderBlockers(
  workflow,
  name,
  validatorTarget,
  trustedAliases,
  installAction,
) {
  const steps = ciJob(workflow, name).steps ?? [];
  let validatorIndex = -1;
  let installIndex = -1;
  const aliasHits = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isPlainObject(step)) continue;
    if (typeof step.uses === "string") {
      if (step.uses === installAction && installIndex < 0) installIndex = index;
      continue;
    }
    if (typeof step.run !== "string" || stepBlockers(step).length > 0) continue;
    const { commands, blocker } = parseShellScript(step.run);
    if (blocker) continue;
    if (
      validatorIndex < 0 &&
      commands.length === 1 &&
      isCommand(commands[0], validatorTarget)
    ) {
      validatorIndex = index;
    }
    for (const command of commands) {
      if (command[0] !== "pnpm") continue;
      const alias = command[1] === "run" ? command[2] : command[1];
      if (typeof alias === "string" && trustedAliases.has(alias)) {
        aliasHits.push({ index, run: command.join(" ") });
      }
    }
  }
  if (validatorIndex < 0) {
    return [
      `the \`${name}\` job never runs \`${validatorTarget.join(" ")}\` as a whole step command, ` +
        "so it runs pnpm-install and trusted aliases without rejecting lifecycle hooks or validating pins first",
    ];
  }
  const blockers = [];
  if (installIndex >= 0 && installIndex < validatorIndex) {
    blockers.push(
      `the \`${name}\` job runs \`${installAction}\` (step ${installIndex}) before the pin validator ` +
        `(step ${validatorIndex}) — a root install lifecycle hook would run before the validator rejects it`,
    );
  }
  for (const hit of aliasHits) {
    if (hit.index < validatorIndex) {
      blockers.push(
        `the \`${name}\` job runs \`${hit.run}\` (step ${hit.index}) before the pin validator ` +
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

// `requiredPathsMissing` — the guard → output → paths-filter chain walk — was
// retired with the rest of the reachability proof in issue #1779 PR C. It
// existed because this checker ran inside the path-gated `scripts` job, so a
// filter that stopped routing one of its inputs skipped the job silently. The
// checker now runs in the unconditional `sentry-suites` job, which has no
// filter to follow.

// The command-grammar and package.json-alias predicates were moved to
// check-sentry-suites-in-ci-core-commands.mjs and re-exported at the top of
// this file.
