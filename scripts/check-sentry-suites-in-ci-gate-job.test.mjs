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
 * Split into its own module so the entry point and the core stay under the
 * repo's 1,000-line cap; the main test file imports this module, so `node
 * scripts/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActionList } from "./check-sentry-suites-in-ci-core.mjs";
import { allsGreenStep, CI } from "./check-sentry-suites-in-ci-probes.mjs";

/** The job key, and the check-run name the branch ruleset would require. */
export const GATE_JOB = "sentry-suites";

/** The command the gate step must run, as its whole command. */
export const GATE_COMMAND =
  "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry-suite-gate.mjs";

/**
 * The only actions allowed to execute before the gate command. Both are
 * upstream and SHA-pinned; they are the two non-PR-authored things trusted
 * ahead of the suites. Anything else before the gate reopens the R1 window,
 * where a step writing `NODE_OPTIONS=--import=…` to `$GITHUB_ENV` neuters every
 * later suite in the job into a false-green no-op.
 */
export const PRE_GATE_ACTIONS = ["actions/checkout@", "actions/setup-node@"];

/**
 * Everything that stops the `sentry-suites` job from being an unconditional,
 * merge-blocking run of the suite gate with no PR-authored code in front of it.
 *
 * @param {Record<string, any>} workflow
 * @returns {string[]} blockers; empty means the job is intact
 */
export function gateJobBlockers(workflow) {
  const blockers = [];
  const jobs = workflow?.jobs;
  const job = jobs?.[GATE_JOB];

  // 1. It exists at all. This is the deletion that nothing else catches.
  if (!job || typeof job !== "object") {
    return [
      `the \`${GATE_JOB}\` job is gone from ci.yml — it is the only thing that runs the ` +
        "Sentry suites and proves from their output that they asserted; nothing else " +
        "detects its absence, so removing it silently restores the false-green it closes",
    ];
  }

  // 2. Unconditional. GitHub reports a skipped required check as satisfied, so
  // any `if:` is a merge-gate hole rather than a scheduling nicety.
  if (job.if !== undefined) {
    blockers.push(
      `the \`${GATE_JOB}\` job carries \`if: ${job.if}\` — it must be unconditional, because ` +
        "a skipped job reports success and would satisfy both the `ci` sentinel and a " +
        "required status check without running a single suite",
    );
  }

  // 3. The sentinel depends on it, or its result never reaches the required
  // `ci` context.
  const needs = jobs?.ci?.needs ?? [];
  const needsList = Array.isArray(needs) ? needs : [needs];
  if (!needsList.includes(GATE_JOB)) {
    blockers.push(
      `the \`ci\` sentinel does not list \`${GATE_JOB}\` in \`needs\` — a red gate would ` +
        "then leave the required `ci` context green",
    );
  }

  // 4. Never skippable/failable by the sentinel's allowlists.
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

  // 5. No job-level env. An `env:` on the job reaches every step, which is the
  // injection the gate's own refuse-to-start guard exists to catch.
  if (job.env !== undefined) {
    blockers.push(
      `the \`${GATE_JOB}\` job declares a job-level \`env:\` — it must not, because a ` +
        "job-level variable reaches the gate step and every suite it spawns",
    );
  }

  // 6. Nothing in this job may tolerate its own failure. `continue-on-error`
  // makes a red gate report success, so the `ci` sentinel never blocks the
  // merge and a floor breach or a failed assertion ships — the same class the
  // sentinel predicates already reject one level up, applied here. Checked on
  // the job AND on every step rather than only on the step matching the gate
  // command, so it holds however the gate step is identified.
  if (job["continue-on-error"] !== undefined) {
    blockers.push(
      `the \`${GATE_JOB}\` job sets \`continue-on-error\` — a failing gate would then ` +
        "report success and the required `ci` context would stay green",
    );
  }
  for (const [index, step] of (Array.isArray(job.steps)
    ? job.steps
    : []
  ).entries()) {
    if (step?.["continue-on-error"] === undefined) continue;
    const label = step?.name ?? step?.uses ?? `step ${index + 1}`;
    blockers.push(
      `step \`${label}\` in \`${GATE_JOB}\` sets \`continue-on-error\` — no step here may ` +
        "tolerate its own failure; the gate's verdict is the job's verdict",
    );
  }

  // 7. The checkout must be the PR revision of THIS repository. `with.ref` or
  // `with.repository` redirects the job to validate other code — pointing `ref`
  // at `main` makes every suite run the base branch, so a PR deleting a test
  // case passes the gate while the diff under review is never executed.
  const checkout = (Array.isArray(job.steps) ? job.steps : []).find((step) =>
    String(step?.uses ?? "").startsWith("actions/checkout@"),
  );
  for (const key of ["ref", "repository"]) {
    if (checkout?.with?.[key] === undefined) continue;
    blockers.push(
      `the \`${GATE_JOB}\` checkout sets \`with.${key}: ${checkout.with[key]}\` — it must take ` +
        "neither, so the job always runs the suites from the pull request's own revision of " +
        "this repository rather than validating some other code",
    );
  }

  // 8. The gate runs, as its whole command, with the tamper variables stripped.
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const gateIndex = steps.findIndex(
    (step) => String(step?.run ?? "").trim() === GATE_COMMAND,
  );
  if (gateIndex === -1) {
    blockers.push(
      `no step in \`${GATE_JOB}\` runs \`${GATE_COMMAND}\` as its whole command — an ` +
        "added argument, a `|| true`, or a changed `env -u` prefix all stop it counting",
    );
    return blockers;
  }

  // 9. Nothing PR-authored executes before it. Only the two pinned upstream
  // actions may precede the gate; a `run:` step, a local composite action, or
  // any other `uses:` ahead of it is PR-authored code in the R1 window.
  for (const [index, step] of steps.slice(0, gateIndex).entries()) {
    const uses = String(step?.uses ?? "");
    const label = step?.name ?? (uses || `step ${index + 1}`);
    if (step?.run !== undefined) {
      blockers.push(
        `\`${GATE_JOB}\` runs a \`run:\` step (${label}) BEFORE the gate — no PR-authored ` +
          "command may execute first; such a step can append `NODE_OPTIONS=--import=…` to " +
          "$GITHUB_ENV and neuter every suite the gate then runs",
      );
    } else if (!PRE_GATE_ACTIONS.some((prefix) => uses.startsWith(prefix))) {
      blockers.push(
        `\`${GATE_JOB}\` uses \`${uses}\` BEFORE the gate — only ${PRE_GATE_ACTIONS.join(
          " and ",
        )} may precede it; anything else (a local composite action especially) is ` +
          "PR-authored code running ahead of the suites",
      );
    }
    if (step?.env !== undefined) {
      blockers.push(
        `a step before the gate (${label}) declares \`env:\` — it must not, for the same reason`,
      );
    }
  }

  // 10. The gate step itself carries no env.
  if (steps[gateIndex]?.env !== undefined) {
    blockers.push(
      "the gate step declares a step-level `env:` — the gate must start from a clean " +
        "environment, which is why it refuses to run when NODE_OPTIONS or NODE_PATH is set",
    );
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
      step.run = "node scripts/sentry-suite-gate.mjs";
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
