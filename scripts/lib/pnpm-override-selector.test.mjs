/**
 * Contract tests for the shared pnpm override selector parser.
 *
 * Run: node --test scripts/lib/pnpm-override-selector.test.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isPeerSelectorSeparator,
  packageNameFromOverrideSelector,
  peerQualifiedSelectorParts,
} from "./pnpm-override-selector.mjs";
import * as overridePruneReport from "../supply-chain/override-prune-report.mjs";

const SCRIPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("splits path qualifiers without splitting range comparators", () => {
  assert.deepEqual(peerQualifiedSelectorParts("esbuild"), ["esbuild"]);
  assert.deepEqual(peerQualifiedSelectorParts("@lhci/utils>js-yaml"), [
    "@lhci/utils",
    "js-yaml",
  ]);
  assert.deepEqual(peerQualifiedSelectorParts("parent>child@>=1 <2"), [
    "parent",
    "child@>=1 <2",
  ]);
  assert.deepEqual(peerQualifiedSelectorParts("@babel/core@>=7.0.0 <7.29.6"), [
    "@babel/core@>=7.0.0 <7.29.6",
  ]);
});

test("isPeerSelectorSeparator rejects comparator positions", () => {
  // "a>b": the `>` at index 1 follows a name character and precedes one.
  assert.equal(isPeerSelectorSeparator("a>b", 1), true);
  // "a@>=1": the `>` follows `@` and precedes `=`.
  assert.equal(isPeerSelectorSeparator("a@>=1", 2), false);
  // A trailing `>` separates nothing.
  assert.equal(isPeerSelectorSeparator("a>", 1), false);
});

test("packageNameFromOverrideSelector strips qualifiers and ranges", () => {
  assert.equal(packageNameFromOverrideSelector("esbuild"), "esbuild");
  assert.equal(
    packageNameFromOverrideSelector("body-parser@<1.20.3"),
    "body-parser",
  );
  assert.equal(
    packageNameFromOverrideSelector("@lhci/utils>js-yaml"),
    "js-yaml",
  );
  assert.equal(
    packageNameFromOverrideSelector("@babel/core@>=7.0.0 <7.29.6"),
    "@babel/core",
  );
});

// The dedup invariant. lockfile-lint's override-range gate fails CI and
// override-prune-report never fails anything, so a second copy of this parser
// could drift on one side and stay green on both. These two assertions fail
// the moment either consumer stops reading this module.
test("both consumers parse selectors with this exact module", async () => {
  assert.equal(
    overridePruneReport.packageNameFromOverrideSelector,
    packageNameFromOverrideSelector,
    "override-prune-report must re-export the shared parser, not a copy",
  );

  const overrideRangeGate = await readFile(
    resolve(SCRIPTS_ROOT, "supply-chain/lockfile-lint-override-ranges.mjs"),
    "utf8",
  );
  assert.match(
    overrideRangeGate,
    /^import \{\n(?:.*\n)*?\} from "\.\.\/lib\/pnpm-override-selector\.mjs";$/m,
    "the lockfile-lint override-range gate must import the shared parser",
  );
  assert.doesNotMatch(
    overrideRangeGate,
    /function (?:isPeerSelectorSeparator|peerQualifiedSelectorParts|packageNameFromOverrideSelector)\b/,
    "the lockfile-lint override-range gate must not redefine the parser",
  );
});
