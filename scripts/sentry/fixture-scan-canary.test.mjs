#!/usr/bin/env node
/**
 * Drift canary for the credential-shaped fixtures in the Sentry suites
 * (issues #1943 and #1970, ADR 0068).
 *
 * The four suites below carry adversarial fixtures — credential-shaped values
 * that prove the pipeline refuses to leak them. Written the wrong way, those
 * fixtures make the suite file itself trip `secretLikeReason`, and every
 * `pnpm agent:autoreview` run that puts the file in its bundle refuses before
 * a model ever sees the diff. The fixtures were rewritten to scan clean; this
 * canary keeps them that way.
 *
 * Two failure modes, both covered:
 *   - a fixture regresses to the trap shape (credential-named key + a
 *     realistic-shaped literal), so the whole-file scan stops being null;
 *   - a suite is renamed or deleted and the canary silently watches nothing.
 *
 * The name deliberately does NOT start with `sentry-`: `findSentrySuites()` in
 * scripts/sentry/gate/sentry-suite-gate.mjs keys on that basename prefix and
 * reconciles what it finds against sentry-suite-manifest.json by exact set
 * equality, so a `sentry-*.test.mjs` here would have to be a manifest-owned
 * suite. This file is routed by scripts/agent-quality-gate.sh and by the
 * `scripts` job in .github/workflows/ci.yml instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { secretLikeReason } from "../agent-autoreview-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(
  ROOT,
  "scripts",
  "sentry",
  "gate",
  "sentry-suite-manifest.json",
);

/**
 * The four suites the #1943/#1970 rewrite touched. Every one of them holds
 * credential-shaped fixtures; each must scan clean as whole text.
 */
const SCANNED_SUITES = [
  "scripts/sentry/autofix/sentry-autofix-finalize.test.mjs",
  "scripts/sentry/broker/sentry-mcp-broker.test.mjs",
  "scripts/sentry/triage/sentry-triage-agent-comment.test.mjs",
  "scripts/sentry/triage/sentry-triage-archive.test.mjs",
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// The load-bearing sanity check: every assertion below is a claim that
// `secretLikeReason` returned null, which a broken import or a gutted scanner
// satisfies for free. Prove first that this scanner still refuses the exact
// trap shape the rewrite moved the fixtures off — a credential-named key with a
// realistic-shaped literal value. Composed from fragments at runtime so this
// file's own source stays scannable (the convention in
// scripts/agent-autoreview-core.test.mjs).
test("negative control: the scanner still refuses a credential-named literal", () => {
  const trapShape = [
    ["api", "Key", ": "].join(""),
    '"',
    ["prod-", "secret-", "1234567890"].join(""),
    '"',
  ].join("");
  const reason = secretLikeReason(trapShape);
  assert(
    reason !== null,
    "secretLikeReason cleared a credential-named literal — the canary below is vacuous until it refuses again",
  );
});

test("the canary watches every suite the rewrite touched", () => {
  assert(
    SCANNED_SUITES.length === 4,
    `expected the four rewritten suites, got ${SCANNED_SUITES.length}`,
  );
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const suite of SCANNED_SUITES) {
    assert(
      Object.prototype.hasOwnProperty.call(manifest.suites, suite),
      `${suite} is not in sentry-suite-manifest.json — one of the two lists moved without the other`,
    );
  }
});

for (const suite of SCANNED_SUITES) {
  test(`${suite} exists`, () => {
    assert(
      existsSync(join(ROOT, suite)),
      `${suite} is gone — a rename or deletion must update SCANNED_SUITES here, or this canary watches nothing`,
    );
  });

  test(`${suite} scans clean as whole text`, () => {
    const reason = secretLikeReason(readFileSync(join(ROOT, suite), "utf8"));
    assert(
      reason === null,
      `${suite} trips the autoreview scanner (${reason}). A fixture regressed to the trap shape: a credential-named identifier or key holding a realistic-shaped literal. Use placeholder vocabulary, or a non-credential-named identifier — see docs/adr/0068-sentry-fixture-authoring-policy.md.`,
    );
  });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
