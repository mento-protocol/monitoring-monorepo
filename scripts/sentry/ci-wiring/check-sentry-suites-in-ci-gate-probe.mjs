/**
 * The gate-routing probe behind scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs.
 *
 * `gateClassifications` proves the quality gate routes a given root
 * `package.json` change to the right focused-test arm — specifically, that every
 * `sentry:*` alias is one the gate TRUSTS, so `agent:quality-gate --run` will
 * execute it without `--allow-package-script-changes`.
 *
 * D5C CHANGED HOW, NOT WHAT. Until D5c the gate's routing was bash `case` arms,
 * and this module answered the question by lifting the gate's own
 * `classify_root_package_json_changes` out of `scripts/agent-quality-gate.sh`
 * and re-executing it under a shell with an empty `$PATH`, stubbed helpers and
 * a DEBUG trap — roughly 700 lines whose whole job was making that safe and
 * honest. ADR 0069 retired the arms; the classifier is
 * `classifyRootPackageJsonChanges` in the mapping engine now, so the probe calls
 * it. Everything the shell machinery existed to bound — an unprovided command,
 * a read of host state, an over-captured function span, a non-terminating
 * classifier — cannot arise from a function call, and the residuals that section
 * described are gone with it.
 *
 * WHAT DID NOT CHANGE is the closed verdict set. A classification outside
 * `ROOT_PACKAGE_JSON_CLASSES` fails here rather than being stored as a
 * plausible-looking string, because the callers compare verdicts to literals: a
 * renamed class would make every `assert.equal(verdict, "root-tooling-scripts")`
 * red for a reason nobody could read, and a NEW class would quietly widen what
 * the allowlist test believes it proved. A gate that grows a class must be
 * re-read here, on purpose.
 *
 * The lifting machinery itself stays in
 * check-sentry-suites-in-ci-gate-extract.mjs: two other checks use it —
 * ADR 0069's routing-table suite reads `implementation_signature()` with
 * `bashFunctionSource` and drives `/bin/bash` as the pattern oracle through
 * `runProbeShell`/`probeDirs`.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  classifyRootPackageJsonChanges,
  ROOT_PACKAGE_JSON_CLASSES,
} from "../../gate/mapping/facts.mjs";

/** The module that decides the class, for error messages that name a file. */
export const GATE_CLASSIFIER_PATH = fileURLToPath(
  new URL("../../gate/mapping/facts.mjs", import.meta.url),
);

/** The name of the engine function `gateClassifications` calls. */
export const GATE_CLASSIFIER = "classifyRootPackageJsonChanges";

/**
 * Every class the root-manifest classifier may answer. The probe rejects
 * anything else, so a verdict that came from a renamed or newly added class
 * fails the test instead of being stored as a plausible-looking string.
 *
 * Written out here rather than re-exported from the engine, and that
 * duplication is the point. Deriving the accepted set from
 * `ROOT_PACKAGE_JSON_CLASSES` would make it widen by itself: a fifth class added
 * to `facts.mjs` would arrive here as "accepted", and the callers that compare
 * verdicts to string literals would never be re-read. Adding a class has to cost
 * an edit in this file.
 */
export const GATE_ROOT_PACKAGE_JSON_CLASSES = new Set([
  "workspace",
  "workspace-dev-metadata",
  "root-tooling-scripts",
  "package-scripts",
]);

// And the two lists have to agree, at import, in both directions: a class the
// engine dropped would leave a name here that nothing can produce, and a class
// the engine added without an edit here is the widening above. Neither is
// something to discover halfway through a suite.
{
  const engine = [...ROOT_PACKAGE_JSON_CLASSES].sort();
  const accepted = [...GATE_ROOT_PACKAGE_JSON_CLASSES].sort();
  assert.deepEqual(
    accepted,
    engine,
    `${GATE_CLASSIFIER_PATH} answers ${JSON.stringify(engine)}; this probe accepts ` +
      `${JSON.stringify(accepted)}. Reconcile them here on purpose, and re-read every caller ` +
      "that compares a verdict to a string literal before widening the accepted set.",
  );
}

/**
 * Classify each JSON-pointer change path on its own, as the gate would if that
 * were the only change in the root manifest.
 *
 * One path per call is the question the callers ask: "if a manifest edit touched
 * ONLY this key, would the gate trust it?" Batching them would answer a
 * different question, because the classes combine — one untrusted pointer beside
 * fifty trusted ones is `package-scripts` for the whole set.
 *
 * @param {readonly string[]} paths JSON-pointer paths, e.g. `/scripts/tf:test`
 * @returns {Map<string, string>} path → class
 */
export function gateClassifications(paths) {
  assert.ok(
    Array.isArray(paths) && paths.length > 0,
    "gateClassifications needs at least one path; an empty request would vacuously pass every caller",
  );
  for (const path of paths) {
    assert.equal(
      typeof path,
      "string",
      `gateClassifications was handed a non-string path: ${JSON.stringify(path)}`,
    );
    assert.notEqual(path, "", "gateClassifications was handed an empty path");
  }
  assert.equal(
    new Set(paths).size,
    paths.length,
    "gateClassifications was handed a duplicate path; the verdict map would collapse them",
  );

  const verdicts = new Map();
  for (const path of paths) {
    const verdict = classifyRootPackageJsonChanges([path]);
    assert.ok(
      GATE_ROOT_PACKAGE_JSON_CLASSES.has(verdict),
      `\`${GATE_CLASSIFIER}\` in ${GATE_CLASSIFIER_PATH} classified ${JSON.stringify(path)} as ` +
        `${JSON.stringify(verdict)}, which is not one of its closed classes ` +
        `(${[...GATE_ROOT_PACKAGE_JSON_CLASSES].join(", ")}) — the gate grew or renamed a class, ` +
        "and every caller comparing verdicts to literals has to be re-read before this list is widened",
    );
    verdicts.set(path, verdict);
  }
  return verdicts;
}
