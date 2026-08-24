/**
 * The gate-routing probe's own invariants.
 *
 * `gateClassifications` is what
 * check-sentry-suites-in-ci-coverage.test.mjs believes when it asserts that
 * every `sentry:*` alias is one the quality gate TRUSTS. A probe that answered
 * "root-tooling-scripts" to everything would pass that test on an allowlist
 * that had lost half its entries, so the probe is checked here before its
 * verdicts are believed anywhere else.
 *
 * This file used to be 821 lines, almost all of it about the shell: the probe
 * lifted `classify_root_package_json_changes` out of `agent-quality-gate.sh`
 * and re-ran it under an empty `$PATH`, stubbed helpers, restricted mode and a
 * DEBUG trap, and every one of those layers needed its own control. ADR 0069's
 * D5c retired the gate's bash routing, so the classifier is a function in the
 * mapping engine and the probe calls it. What is left to check is what a
 * function call can still get wrong: a request it would misread, and a verdict
 * outside the closed class set.
 *
 * The extraction machinery those tests exercised is not gone — it moved to the
 * checks that still use it, and check-sentry-suites-in-ci-gate-extract.test.mjs
 * covers it there.
 *
 * The main check imports this module, so
 * `node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` runs it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOT_PACKAGE_JSON_CLASSES,
  classifyRootPackageJsonChanges,
} from "../../gate/mapping/facts.mjs";
import {
  TRUSTED_PATH,
  UNTRUSTED_PATH,
} from "./check-sentry-suites-in-ci-gate-fixtures.mjs";
import {
  GATE_CLASSIFIER,
  gateClassifications,
  GATE_ROOT_PACKAGE_JSON_CLASSES,
} from "./check-sentry-suites-in-ci-probes.mjs";

test("the probe reproduces a known-trusted and a known-untrusted pointer", () => {
  // The control every caller depends on. A probe that classified nothing, or
  // classified everything the same way, would make the allowlist assertions
  // vacuous rather than red.
  const verdicts = gateClassifications([TRUSTED_PATH, UNTRUSTED_PATH]);
  assert.deepEqual(
    [...verdicts],
    [
      [TRUSTED_PATH, "root-tooling-scripts"],
      [UNTRUSTED_PATH, "package-scripts"],
    ],
  );
});

test("each of the four classes is reachable, by a pointer that produces it", () => {
  // The closed set is only a real constraint while every member of it is
  // something the classifier still answers. A class nobody can reach is a name
  // in a list, and a class that disappeared would otherwise go unnoticed until
  // some caller's `assert.equal` against a literal started failing for a reason
  // nobody could read.
  const reached = new Map([
    [TRUSTED_PATH, "root-tooling-scripts"],
    [UNTRUSTED_PATH, "package-scripts"],
    ["/devDependencies/typescript", "workspace-dev-metadata"],
    ["/packageManager", "workspace"],
  ]);
  for (const [path, expected] of reached) {
    assert.equal(
      gateClassifications([path]).get(path),
      expected,
      `${path} no longer classifies as ${expected}`,
    );
  }
  assert.deepEqual(
    [...new Set(reached.values())].sort(),
    [...GATE_ROOT_PACKAGE_JSON_CLASSES].sort(),
    "the closed class set and the classes this test can actually reach have diverged",
  );
});

test("the closed class set is written out, and matches the engine", () => {
  // The probe's accepted set is a LITERAL, not a re-export, so a class added to
  // the engine cannot arrive here as "accepted" while the callers that compare
  // verdicts to string literals go unread. The module asserts the two agree at
  // import; this asserts the literal is really four names rather than something
  // derived from the export it is checked against.
  assert.deepEqual([...GATE_ROOT_PACKAGE_JSON_CLASSES].sort(), [
    "package-scripts",
    "root-tooling-scripts",
    "workspace",
    "workspace-dev-metadata",
  ]);
  assert.deepEqual(
    [...GATE_ROOT_PACKAGE_JSON_CLASSES].sort(),
    [...ROOT_PACKAGE_JSON_CLASSES].sort(),
  );
  assert.equal(GATE_CLASSIFIER, "classifyRootPackageJsonChanges");
  assert.equal(
    typeof classifyRootPackageJsonChanges,
    "function",
    "the probe names an engine export that is not a function",
  );
});

test("a verdict outside the closed set fails rather than being stored", () => {
  // The failure mode being designed out: a renamed or newly added class read
  // back as a plausible-looking string and compared, successfully, against
  // nothing. The production path cannot be handed a different classifier — that
  // is the point of importing it — so the rejection is asserted on the same
  // predicate the probe applies, over the shapes a drifting gate produces.
  for (const verdict of [
    "root-tooling-scriptz", // a rename
    "root-tooling", // a truncation
    "workspace-tooling", // a newly invented class
    "", // a classifier that fell through to no answer
    "ROOT-TOOLING-SCRIPTS", // a case change
  ]) {
    assert.ok(
      !GATE_ROOT_PACKAGE_JSON_CLASSES.has(verdict),
      `${JSON.stringify(verdict)} would be accepted as a class`,
    );
  }
});

test("the probe rejects a request it would answer wrongly", () => {
  // Each of these would produce a map that looks like an answer: an empty
  // request passes every caller vacuously, and a duplicate collapses two
  // questions into one entry.
  for (const request of [[], "not-an-array", [""], [42], [null]]) {
    assert.throws(
      () => gateClassifications(request),
      /gateClassifications/,
      `the probe accepted ${JSON.stringify(request)}`,
    );
  }
  assert.throws(
    () => gateClassifications([TRUSTED_PATH, TRUSTED_PATH]),
    /duplicate path/,
  );
});

test("one path per call, because the classes combine", () => {
  // `gateClassifications` asks the classifier about each path ALONE. Handing it
  // the whole set at once would answer a different question — one untrusted
  // pointer beside fifty trusted ones is `package-scripts` for all of them — and
  // the allowlist test would then report every alias as untrusted the moment a
  // single one drifted, or worse, the reverse.
  assert.equal(
    classifyRootPackageJsonChanges([TRUSTED_PATH, UNTRUSTED_PATH]),
    "package-scripts",
    "the classifier no longer widens when a set mixes trusted and untrusted pointers",
  );
  const verdicts = gateClassifications([TRUSTED_PATH, UNTRUSTED_PATH]);
  assert.equal(
    verdicts.get(TRUSTED_PATH),
    "root-tooling-scripts",
    "the probe classified the set rather than the paths",
  );
});
