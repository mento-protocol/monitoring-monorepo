/**
 * The execution-surface invariants behind scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs.
 *
 * pnpm has two lifecycle phases that run code the coverage checker's static scan
 * of ci.yml and package.json cannot see:
 *
 *   RUN     — a trusted `pnpm <alias>` step runs whatever its package.json
 *             command expands to, so a drifted alias runs an appended command.
 *   INSTALL — `pnpm install` runs the root lifecycle hooks (postinstall and
 *             friends), and pnpm auto-runs `pre<x>`/`post<x>` around a script.
 *
 * Both are closed by the pin validator (check-agent-quality-gate-package-scripts.mjs)
 * running FIRST: it pins each trusted alias to an exact command and rejects any
 * unsanctioned lifecycle hook. These tests pin that ordering and prove the
 * validator rejects a hook. That validator is what makes the local gate's trust
 * in the `sentry:*` aliases safe, which is why this checker carries it.
 *
 * The gate probe is the third execution surface, and its invariants live next
 * door in check-sentry-suites-in-ci-gate-probe.test.mjs.
 *
 * Split out of the main check to keep both files under the repo's 1,000-line cap;
 * the main test file imports this module, so `node
 * scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { pinValidationOrderBlockers } from "./check-sentry-suites-in-ci-core.mjs";
import {
  CI,
  INSTALL_ACTION,
  PIN_VALIDATOR_COMMAND,
  PKG,
  runPackageScriptValidator,
  validatorPins,
} from "./check-sentry-suites-in-ci-probes.mjs";

// The set of aliases the validator pins is the set it trusts; the pin-order
// check flags any of them run before the validator. `validatorPins` reads the
// validator's own report, so a rename or a dropped pin changes this set too.
const TRUSTED_ALIASES = new Set(validatorPins().keys());
const VALIDATOR_RUN = PIN_VALIDATOR_COMMAND.join(" ");
const QUALITY_GATE_TEST_RUN = "pnpm agent:quality-gate:test";
const CI_WIRING_RUN =
  "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs";

function exactRunIndexes(job, command) {
  return (job?.steps ?? [])
    .map((step, index) => (step?.run === command ? index : -1))
    .filter((index) => index >= 0);
}

test("the `scripts` job validates pins before pnpm-install and any trusted alias", () => {
  // The validator makes two surfaces safe only by running first: before
  // pnpm-install (so a root lifecycle hook is rejected before install runs it,
  // Codex 3754887736) and before any trusted `pnpm <alias>` step (so a drifted
  // alias is rejected before it runs an appended command, Codex 3754887737).
  assert.deepEqual(
    pinValidationOrderBlockers(
      CI,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the `scripts` job runs pnpm-install or a trusted alias before the pin validator",
  );

  // Probe 1: drop the validator step entirely.
  const withoutValidator = structuredClone(CI);
  withoutValidator.jobs.scripts.steps =
    withoutValidator.jobs.scripts.steps.filter(
      (step) => step.run !== VALIDATOR_RUN,
    );
  assert.notDeepEqual(
    pinValidationOrderBlockers(
      withoutValidator,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the order check accepts a `scripts` job with no pin validator step",
  );

  // Probe 2: move the validator to the end, after install and the aliases.
  const reordered = structuredClone(CI);
  const steps = reordered.jobs.scripts.steps;
  const at = steps.findIndex((step) => step.run === VALIDATOR_RUN);
  assert.ok(at >= 0, "pin validator step is gone — probe would prove nothing");
  const [validator] = steps.splice(at, 1);
  steps.push(validator);
  assert.notDeepEqual(
    pinValidationOrderBlockers(
      reordered,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the order check accepts a validator that runs after pnpm-install and the aliases",
  );
});

test("required CI independently pins the quality-gate contract suite", () => {
  // This assertion lives in the independently invoked Sentry CI-wiring suite,
  // not in agent-quality-gate.test.sh. The suite under test therefore cannot
  // remove its own CI step without this required check failing.
  const validatorIndexes = exactRunIndexes(CI.jobs?.scripts, VALIDATOR_RUN);
  const qualityGateIndexes = exactRunIndexes(
    CI.jobs?.scripts,
    QUALITY_GATE_TEST_RUN,
  );
  assert.equal(
    validatorIndexes.length,
    1,
    `the \`scripts\` job must contain exactly \`run: ${VALIDATOR_RUN}\``,
  );
  assert.equal(
    qualityGateIndexes.length,
    1,
    `the \`scripts\` job must contain exactly \`run: ${QUALITY_GATE_TEST_RUN}\``,
  );
  assert.ok(
    validatorIndexes[0] < qualityGateIndexes[0],
    `the \`scripts\` job must run \`${VALIDATOR_RUN}\` before \`${QUALITY_GATE_TEST_RUN}\``,
  );

  const sentinelNeeds = Array.isArray(CI.jobs?.ci?.needs)
    ? CI.jobs.ci.needs
    : [CI.jobs?.ci?.needs];
  assert.ok(
    sentinelNeeds.includes("scripts"),
    "the required `ci` sentinel must include `scripts` in `needs`",
  );

  assert.deepEqual(
    exactRunIndexes(CI.jobs?.["sentry-suites"], CI_WIRING_RUN),
    [4],
    "the independently invoked `sentry-suites` job must run this CI-wiring suite at its pinned step",
  );
  assert.ok(
    sentinelNeeds.includes("sentry-suites"),
    "the required `ci` sentinel must include `sentry-suites` in `needs`",
  );
});

test("the pin validator rejects an unsanctioned install lifecycle hook", () => {
  // The real manifest — its one sanctioned `postinstall` and no other hook —
  // must pass, or a clean tree would red the job.
  assert.ok(
    runPackageScriptValidator(PKG).ok,
    "the validator rejects the real, clean package.json",
  );

  // Each mutation adds or drifts a lifecycle hook that would run trusted code
  // outside the static scan; the validator, run before install, must reject it.
  const mutations = [
    ["preinstall", { ...PKG.scripts, preinstall: "node scripts/evil.mjs" }],
    ["postinstall", { ...PKG.scripts, postinstall: "node scripts/evil.mjs" }],
    [
      "presentry:ingest:test",
      { ...PKG.scripts, "presentry:ingest:test": "node scripts/evil.mjs" },
    ],
  ];
  for (const [label, scripts] of mutations) {
    assert.ok(
      !runPackageScriptValidator({ ...PKG, scripts }).ok,
      `the validator accepted a package.json with a \`${label}\` lifecycle hook`,
    );
  }
});

// The escaping-symlink rejection lived here until issue #1779 PR C. It refused
// a committed `scripts/<link>` resolving outside scripts/, because such a link
// exposes suites whose real path the static `rootScripts` filter cannot route:
// adding one under a previously committed link skipped the path-gated `scripts`
// job while the checker still demanded the suite (Codex 3754887739). The
// unconditional `sentry-suites` gate removed the premise. It enumerates through
// the same link, reconciles what it finds against the manifest by exact set
// equality, and RUNS the suite — from a job with no paths filter to escape.
