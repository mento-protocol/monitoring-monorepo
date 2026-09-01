/**
 * The structural invariants of the unconditional `sentry-suites` gate job
 * (issue #1779, ADR 0062).
 *
 * The gate proves the Sentry suites actually ran. What it cannot prove is its
 * OWN existence: delete the job, give it an `if:`, drop it from the `ci`
 * sentinel's `needs`, list it under `allowed-skips`, or slip a PR-authored step
 * in front of the gate command, and every check in this repository still passes
 * while the gate stops guarding anything. Verified before this file existed: with
 * the whole job block and its `needs` entry removed from ci.yml,
 * `check-sentry-suites-in-ci.test.mjs`, `sentry-suite-gate.mjs`, and
 * `agent-quality-gate.test.sh` all exited 0.
 *
 * A runtime gate cannot detect its own deletion, so the static checker has to
 * carry it. `gateJobBlockers` is the predicate; `GATE_JOB_MUTATIONS` are the
 * ways to break the job that it must reject, run against a `structuredClone` of
 * the real workflow the same way `SENTINEL_MUTATIONS` are.
 *
 * The job's own shape is asserted by EXACT EQUALITY against `CANONICAL_JOB`
 * rather than by enumerating forbidden properties — see the note there for why
 * the blocklist could not converge and what that costs.
 *
 * Split into its own module so the entry point and the core stay under the
 * repo's 1,000-line cap; the main test file imports this module, so `node
 * scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActionList } from "./check-sentry-suites-in-ci-core.mjs";
import { allsGreenStep, CI } from "./check-sentry-suites-in-ci-probes.mjs";

/** The job key, and the check-run name the branch ruleset would require. */
export const GATE_JOB = "sentry-suites";

/** The command the gate step must run, as its whole command. */
export const GATE_COMMAND =
  "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry/gate/sentry-suite-gate.mjs";

/**
 * The command the checker step must run, as its whole command. This file is
 * part of that checker, so the assertion is bootstrapped either way — but
 * pinning the step inside the canonical shape is strictly stronger than the
 * separate "this check runs in CI" probe it replaced: exact equality also
 * rejects an appended `|| true`, an `if:`, a `working-directory:` and an `env:`
 * on the step.
 */
export const CHECKER_COMMAND =
  "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs";

/**
 * The canonical `sentry-suites` job, in full.
 *
 * This is an ALLOWLIST, not a list of rejected properties, and that inversion is
 * the point. Five rounds of "reject the next bad key" could not converge: the
 * space of workflow keys is open and GitHub keeps adding to it, so a blocklist
 * missed workflow-level `env` (which `env -u` preserves, redirecting the gate at
 * a committed fake root), `working-directory` on the gate step, a SECOND
 * checkout pinned to `main`, an `if:` on the step rather than the job,
 * `container`, `defaults.run.shell`, and a step-level `shell` — all measured as
 * GREEN before this rewrite.
 *
 * The suite set already reconciles by exact set equality rather than "no suite
 * is missing"; this applies the same discipline one level up. Anything the
 * canonical shape does not list is rejected whatever it is called, so the next
 * key nobody has thought of is closed in advance.
 *
 * The cost is deliberate: a legitimate change to this job must update this
 * structure, which forces it to be re-proven in review rather than absorbed
 * silently. That is the same trade the suite-set equality makes. Dependabot
 * bumps to either action SHA need a paired edit here.
 */
export const CANONICAL_JOB = {
  name: "Sentry suites",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 5,
  permissions: { contents: "read" },
  steps: [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ inputs.no_skip_audit && inputs.audit_source_sha || github.sha }}",
        "fetch-depth": "${{ inputs.no_skip_audit && '0' || '1' }}",
        "persist-credentials": false,
      },
    },
    {
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version-file": ".node-version",
        "package-manager-cache": false,
      },
    },
    { name: "Run and assert the Sentry suites", run: GATE_COMMAND },
    // Steps 4-5 (issue #1779, PR C). Both run AFTER the gate: the install's
    // composite `postinstall` is PR-authored code, and putting it in front of
    // the gate would restore the R1 window this job exists to close. Their
    // position is pinned by the array-order equality above, not by a comment.
    {
      uses: "$/.github/actions/pnpm-install",
      with: { "restore-cache": "${{ !inputs.no_skip_audit }}" },
    },
    { name: "Sentry CI wiring assertion", run: CHECKER_COMMAND },
  ],
};

/**
 * Workflow-level keys that would reach this job's runtime if present. Finding 1
 * came from outside the job block entirely — a workflow-level
 * `env: SENTRY_SUITE_GATE_ROOT` survives `env -u` and points the gate at a
 * committed fake manifest — so the assertion cannot stop at the job boundary.
 */
export const FORBIDDEN_WORKFLOW_KEYS = ["env", "defaults"];

/**
 * Where to make the paired edit, named in every mismatch message. Whoever trips
 * this assertion is usually not its author — most often a dependency bump — so
 * the message has to point at the file and constant to change.
 */
const CANONICAL_JOB_NAME =
  "CANONICAL_JOB (scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-job.test.mjs)";

/** True for a plain object (not an array, not null). */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare `actual` against the canonical `expected` by EXACT structure: same key
 * set at every level, same scalar values, same array length and order. Every
 * difference becomes one human-readable blocker naming the path.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} path
 * @param {string[]} blockers
 */
function assertExactShape(actual, expected, path, blockers) {
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      blockers.push(
        `${path} must be a mapping, found ${JSON.stringify(actual)}`,
      );
      return;
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    for (const key of actualKeys) {
      if (!expectedKeys.includes(key)) {
        blockers.push(
          `${path}.${key} is not part of the canonical \`${GATE_JOB}\` shape — this job is ` +
            "pinned by allowlist, so anything not listed is rejected; if the addition is " +
            `legitimate, add it to ${CANONICAL_JOB_NAME} in the same commit so the change is ` +
            "reviewed on its merits",
        );
      }
    }
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key)) {
        blockers.push(`${path}.${key} is missing from the \`${GATE_JOB}\` job`);
        continue;
      }
      assertExactShape(actual[key], expected[key], `${path}.${key}`, blockers);
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      blockers.push(`${path} must be a list, found ${JSON.stringify(actual)}`);
      return;
    }
    if (actual.length !== expected.length) {
      blockers.push(
        `${path} has ${actual.length} entr${actual.length === 1 ? "y" : "ies"}, the canonical ` +
          `shape has exactly ${expected.length} — an inserted step runs PR-authored code in ` +
          "the job, and a removed one drops something the gate depends on",
      );
    }
    for (
      let index = 0;
      index < Math.max(actual.length, expected.length);
      index += 1
    ) {
      if (index >= actual.length || index >= expected.length) continue;
      assertExactShape(
        actual[index],
        expected[index],
        `${path}[${index}]`,
        blockers,
      );
    }
    return;
  }

  if (actual !== expected) {
    // A pinned action SHA is the one mismatch a routine dependency PR will hit,
    // and whoever hits it did not write this check. Spell out the fix and the
    // reason, or the quickest way to make the assertion stop complaining is to
    // loosen the pin — which is the one change it exists to prevent.
    const isActionPin = path.endsWith(".uses");
    const guidance = isActionPin
      ? " — this is a SHA pin, not a version range. If you are bumping the action " +
        `(Dependabot or otherwise), make the paired edit: set this entry in ${CANONICAL_JOB_NAME} ` +
        "to the new SHA in the same commit. Do NOT relax the comparison to a prefix or a version " +
        "tag: the two upstream actions are the only code that runs before the gate in a job whose " +
        "whole premise is that nothing PR-authored runs first, so changing which code that is has " +
        "to be re-proven by a human rather than ride in on a routine dependency PR."
      : ` — if the change is legitimate, update ${CANONICAL_JOB_NAME} to match in the same commit, ` +
        "so the new shape is reviewed on its merits rather than absorbed silently";
    blockers.push(
      `${path} is ${JSON.stringify(actual)}, the canonical shape requires ${JSON.stringify(expected)}${guidance}`,
    );
  }
}

/**
 * Everything that stops the `sentry-suites` job from being an unconditional,
 * merge-blocking run of the suite gate with no PR-authored code in front of it.
 *
 * The job's own shape is asserted by exact equality against `CANONICAL_JOB`
 * (see the note there). The remaining checks are about how the SENTINEL treats
 * the job, which lives outside the job block and so cannot be expressed as part
 * of its structure.
 *
 * @param {Record<string, any>} workflow
 * @returns {string[]} blockers; empty means the job is intact
 */
export function gateJobBlockers(workflow) {
  const blockers = [];
  const jobs = workflow?.jobs;
  const job = jobs?.[GATE_JOB];

  // Existence first: this is the deletion nothing else catches, and every other
  // assertion below would be vacuous without it.
  if (!isRecord(job)) {
    return [
      `the \`${GATE_JOB}\` job is gone from ci.yml — it is the only thing that runs the ` +
        "Sentry suites and proves from their output that they asserted; nothing else " +
        "detects its absence, so removing it silently restores the false-green it closes",
    ];
  }

  // The whole job, by exact structure. Closes every "property nobody thought to
  // reject" in one assertion: an `if:` on the job or on any step, a
  // `working-directory`, a `container`, a `continue-on-error`, an `env:` at
  // either level, an extra checkout, a reordered or inserted step, a changed
  // action SHA, a `with.ref`, or a key GitHub has not shipped yet.
  assertExactShape(job, CANONICAL_JOB, GATE_JOB, blockers);

  // Workflow-level keys that reach this job's runtime from outside its block.
  for (const key of FORBIDDEN_WORKFLOW_KEYS) {
    if (workflow?.[key] === undefined) continue;
    blockers.push(
      `the workflow declares a top-level \`${key}:\` — it would reach the \`${GATE_JOB}\` job ` +
        "and every suite it spawns; a workflow-level `env` survives the step's `env -u` and " +
        "can point the gate at a different root entirely",
    );
  }

  // The sentinel must depend on it, or its result never reaches the required
  // `ci` context.
  const needs = jobs?.ci?.needs ?? [];
  const needsList = Array.isArray(needs) ? needs : [needs];
  if (!needsList.includes(GATE_JOB)) {
    blockers.push(
      `the \`ci\` sentinel does not list \`${GATE_JOB}\` in \`needs\` — a red gate would ` +
        "then leave the required `ci` context green",
    );
  }

  // Never skippable or failable by the sentinel's allowlists.
  const allsGreen = allsGreenStep(workflow);
  for (const key of ["allowed-skips", "allowed-failures"]) {
    const listed = parseActionList(allsGreen?.with?.[key]);
    if (listed.includes(GATE_JOB)) {
      blockers.push(
        `\`${GATE_JOB}\` appears under the sentinel's \`${key}\` — it must never be ` +
          "tolerated, the treatment `production-infra-contract` already receives",
      );
    }
  }

  return blockers;
}

/**
 * Ways to break the gate job. Each `[label, mutate]` rewrites a
 * `structuredClone` of the real workflow; `gateJobBlockers` must reject every
 * one, or a later ci.yml edit that guts the job goes uncaught.
 */
export const GATE_JOB_MUTATIONS = [
  ["a deleted job", (w) => delete w.jobs[GATE_JOB]],
  [
    "an `if:` guard",
    (w) => (w.jobs[GATE_JOB].if = "github.ref == 'refs/heads/main'"),
  ],
  ["an `if: false`", (w) => (w.jobs[GATE_JOB].if = false)],
  [
    "a sentinel `needs` without it",
    (w) => (w.jobs.ci.needs = w.jobs.ci.needs.filter((n) => n !== GATE_JOB)),
  ],
  [
    "the job under `allowed-skips`",
    (w) => {
      allsGreenStep(w).with["allowed-skips"] =
        `${allsGreenStep(w).with["allowed-skips"]},${GATE_JOB}`;
    },
  ],
  [
    "the job under a JSON `allowed-failures`",
    (w) => {
      allsGreenStep(w).with["allowed-failures"] = `["${GATE_JOB}"]`;
    },
  ],
  [
    "a job-level `env:`",
    (w) => (w.jobs[GATE_JOB].env = { NODE_OPTIONS: "--import=./x.mjs" }),
  ],
  [
    "a PR-authored `run:` step before the gate",
    (w) =>
      w.jobs[GATE_JOB].steps.unshift({
        name: "seed",
        run: "bash scripts/seed.sh",
      }),
  ],
  [
    "a local composite action before the gate",
    (w) =>
      w.jobs[GATE_JOB].steps.unshift({
        uses: "./.github/actions/pnpm-install",
      }),
  ],
  [
    "an `env:` on a step before the gate",
    (w) =>
      (w.jobs[GATE_JOB].steps[0].env = { NODE_OPTIONS: "--import=./x.mjs" }),
  ],
  [
    "an `env:` on the gate step",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step.env = { NODE_PATH: "/tmp/shim" };
    },
  ],
  [
    "a dropped `env -u` prefix",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step.run = "node scripts/sentry/gate/sentry-suite-gate.mjs";
    },
  ],
  [
    "an appended `|| true`",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step.run = `${GATE_COMMAND} || true`;
    },
  ],
  [
    "a deleted gate step",
    (w) => {
      w.jobs[GATE_JOB].steps = w.jobs[GATE_JOB].steps.filter((s) => !s.run);
    },
  ],
  [
    "`continue-on-error` on the gate step",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step["continue-on-error"] = true;
    },
  ],
  [
    "`continue-on-error` on the job",
    (w) => (w.jobs[GATE_JOB]["continue-on-error"] = true),
  ],
  [
    "`continue-on-error` on the checkout step",
    (w) => (w.jobs[GATE_JOB].steps[0]["continue-on-error"] = true),
  ],
  [
    "a checkout pinned to `main` instead of the PR revision",
    (w) => {
      const checkout = w.jobs[GATE_JOB].steps.find((s) =>
        String(s.uses ?? "").startsWith("actions/checkout@"),
      );
      checkout.with = { ...checkout.with, ref: "main" };
    },
  ],
  [
    "a checkout redirected to another repository",
    (w) => {
      const checkout = w.jobs[GATE_JOB].steps.find((s) =>
        String(s.uses ?? "").startsWith("actions/checkout@"),
      );
      checkout.with = { ...checkout.with, repository: "attacker/fork" };
    },
  ],

  // ── Round 7: the six the blocklist missed, all measured GREEN before the
  // allowlist rewrite. Each is a property nobody had thought to reject.
  [
    "a workflow-level `env` redirecting the gate's root",
    (w) => ((w.env ??= {}).SENTRY_SUITE_GATE_ROOT = "fixtures/fake-root"),
  ],
  [
    "`working-directory` on the gate step",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step["working-directory"] = "fixtures/fake-root";
    },
  ],
  [
    "a SECOND checkout pinned to `main` before the gate",
    (w) =>
      w.jobs[GATE_JOB].steps.splice(2, 0, {
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: { ref: "main" },
      }),
  ],
  [
    "an `if:` on the gate STEP rather than the job",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step.if = "false";
    },
  ],

  // ── Shapes the blocklist could never have enumerated. These are the point of
  // the inversion: nothing here was ever written down as forbidden, and the
  // allowlist rejects them because they are simply not in the canonical shape.
  [
    "an unrecognised job key (`container`)",
    (w) => (w.jobs[GATE_JOB].container = "ghcr.io/attacker/img"),
  ],
  [
    "an unrecognised job key (`defaults.run.shell`)",
    (w) => (w.jobs[GATE_JOB].defaults = { run: { shell: "bash -c 'true' #" } }),
  ],
  [
    "an unrecognised step key (`shell`)",
    (w) => {
      const step = w.jobs[GATE_JOB].steps.find((s) => s.run);
      step.shell = "bash -c 'exit 0' #";
    },
  ],
  [
    "a workflow-level `defaults`",
    (w) => (w.defaults = { run: { "working-directory": "fixtures/fake" } }),
  ],
  [
    "a bumped checkout SHA without a paired pin edit",
    (w) => {
      const checkout = w.jobs[GATE_JOB].steps.find((s) =>
        String(s.uses ?? "").startsWith("actions/checkout@"),
      );
      checkout.uses =
        "actions/checkout@0000000000000000000000000000000000000000";
    },
  ],
  [
    "a reordered step list (setup-node before checkout)",
    (w) => {
      const steps = w.jobs[GATE_JOB].steps;
      [steps[0], steps[1]] = [steps[1], steps[0]];
    },
  ],
  [
    "a widened `permissions`",
    (w) => (w.jobs[GATE_JOB].permissions = { contents: "write" }),
  ],
  [
    "a renamed job (the check-run name the ruleset would require)",
    (w) => (w.jobs[GATE_JOB].name = "Sentry suites (advisory)"),
  ],
];

test("the `sentry-suites` gate job is intact in ci.yml", () => {
  assert.deepEqual(
    gateJobBlockers(CI),
    [],
    "the unconditional Sentry-suite gate job is not wired the way ADR 0062 requires",
  );
});

test("the gate-job check rejects every way of gutting the job", () => {
  for (const [label, mutate] of GATE_JOB_MUTATIONS) {
    const workflow = structuredClone(CI);
    mutate(workflow);
    assert.notDeepEqual(
      gateJobBlockers(workflow),
      [],
      `the gate-job check accepts a \`${GATE_JOB}\` job with ${label}`,
    );
  }
});
