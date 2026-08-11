/**
 * The execution-surface invariants behind scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * pnpm has two lifecycle phases that run code the coverage checker's static scan
 * of ci.yml and package.json cannot see:
 *
 *   RUN     — a trusted `pnpm <alias>` step runs whatever its package.json
 *             command expands to, so a drifted alias runs an appended command.
 *   INSTALL — `pnpm install` runs the root lifecycle hooks (postinstall and
 *             friends), and pnpm auto-runs `pre<x>`/`post<x>` around a script.
 *
 * Both are closed by the pin validator (check-agent-quality-gate-package-scripts.sh)
 * running FIRST: it pins each trusted alias to an exact command and rejects any
 * unsanctioned lifecycle hook. These tests pin that ordering, prove the validator
 * rejects a hook, and reject a committed scripts/ directory symlink whose target
 * escapes the tree the CI paths-filter routes.
 *
 * The gate probe is the third execution surface, and its invariants live next
 * door in check-sentry-suites-in-ci-gate-probe.test.mjs.
 *
 * Split out of the main check to keep both files under the repo's 1,000-line cap;
 * the main test file imports this module, so `node
 * scripts/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinValidationOrderBlockers } from "./check-sentry-suites-in-ci-core.mjs";
import {
  CI,
  escapingScriptSymlinks,
  INSTALL_ACTION,
  PIN_VALIDATOR_COMMAND,
  PKG,
  runPackageScriptValidator,
  SCRIPTS_DIR,
  validatorPins,
} from "./check-sentry-suites-in-ci-probes.mjs";

// The set of aliases the validator pins is the set it trusts; the pin-order
// check flags any of them run before the validator. `validatorPins` reads the
// validator's own report, so a rename or a dropped pin changes this set too.
const TRUSTED_ALIASES = new Set(validatorPins().keys());
const VALIDATOR_RUN = PIN_VALIDATOR_COMMAND.join(" ");

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

test("no committed scripts/ directory symlink escapes the CI-routed tree", () => {
  // A directory symlink under scripts/ pointing outside it exposes a suite whose
  // real path the static `rootScripts` filter cannot route, so the path-gated
  // `scripts` job would skip while the checker still demands the suite (Codex
  // 3754887739). None may exist.
  assert.deepEqual(
    escapingScriptSymlinks(SCRIPTS_DIR),
    [],
    "a committed scripts/ directory symlink resolves outside scripts/",
  );

  // Mutation: a synthetic tree with `scripts/linked -> ../fixtures` is flagged,
  // while a within-scripts link is not — proving the check rejects only the
  // escaping case, on fixtures so no repo file is touched.
  const base = mkdtempSync(join(tmpdir(), "sentry-escape-probe-"));
  try {
    const scripts = join(base, "scripts");
    const inside = join(scripts, "real-dir");
    const outside = join(base, "fixtures");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentry-hidden.test.mjs"), "// suite\n");
    symlinkSync(outside, join(scripts, "escaping"));
    symlinkSync(inside, join(scripts, "contained"));

    const escaping = escapingScriptSymlinks(scripts);
    assert.equal(
      escaping.length,
      1,
      `expected only the escaping link flagged, got ${JSON.stringify(escaping)}`,
    );
    assert.equal(escaping[0][0], "scripts/escaping");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
