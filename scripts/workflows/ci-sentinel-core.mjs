/**
 * Pure predicates over a parsed `.github/workflows/ci.yml`, used by
 * scripts/workflows/check-ci-contract.mjs.
 *
 * Nothing here reads a file, spawns a process, or closes over repo state:
 * every function takes the structure it judges as an argument. That is what
 * lets the caller run each check twice — once against the real ci.yml, and once
 * against a `structuredClone` with a single field broken. A check that passes
 * on the real workflow has proven only that it accepts; the mutation probes are
 * what prove it rejects.
 *
 * These predicates were written for the Sentry suite-wiring checker
 * (`scripts/sentry/ci-wiring/`) and moved here verbatim when ADR 0106 deleted
 * that tree. They are not Sentry-specific: they judge the `ci` sentinel's
 * ability to turn any red job into a red required check.
 */

import assert from "node:assert/strict";

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
 * A job's checks only guard anything while its red result blocks the merge.
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
  // thirteen path-gated dependencies make `always()` load-bearing, not
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
  // `scripts` or a red `production-infra-contract`
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
