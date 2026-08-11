#!/usr/bin/env node
/**
 * The sentry-suite gate's ISOLATION suite (issue #1779, ADR 0062).
 *
 * Split out of scripts/sentry-suite-gate-integrity.test.mjs when that file hit
 * the repo's 1,000-line hard cap. The seam is the one the design already has:
 * this half owns "can one suite reach another's inputs", the integrity half
 * owns "is the watch set the right set". A pure move — no case was renamed or
 * rewritten, only relocated.
 *
 * Every case here is a fixture the gate must survive:
 *
 *   - a suite rewriting a later suite, a suite that already ran, or a helper
 *     one imports, including the transient rewrite that undoes itself;
 *   - a suite deriving a sibling snapshot's path, or enumerating the base;
 *   - a write into a snapshot, caught before the child that reads it;
 *   - a write into the shared checkout, caught by the post-run sweep;
 *   - a suite forging an exemption's route, or creating a suite mid-run.
 *
 * Named `sentry-*.test.mjs` on purpose, like its siblings: `findSentrySuites`
 * enumerates it, so the gate runs it and holds it to a floor like any other
 * suite. Dependency-free — only `node:` builtins and local sibling modules.
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cleanup,
  countLineSuite,
  makeHarness,
  makeRoot,
  runGate,
  writeManifest,
  writeSuite,
} from "./sentry-suite-gate-fixtures.mjs";
import {
  snapshotDigest,
  snapshotDrift,
  snapshotInputs,
} from "./sentry-suite-gate.mjs";

const { test, assert, assertEqual, summarize } = makeHarness();

/** This repository, for the cases that must hold of the committed tree. */
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

await test("an earlier suite rewriting a later one changes nothing — the victim's real result stands", async () => {
  const root = makeRoot();
  try {
    // Codex 3759964336, then 3761572724. The first round caught this rewrite
    // with digests; the second showed digests could not catch the transient
    // form of it. Each suite now runs from its own snapshot, taken before any
    // child starts, so the attacker's `writeFileSync` lands in ITS OWN copy of
    // the victim — a file nothing else reads. The victim, a genuinely failing
    // suite, runs from a pristine copy and reports its real failure.
    writeSuite(
      root,
      "sentry-aaa-attacker.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./sentry-zzz-victim.test.mjs", import.meta.url)),',
        '  \'process.stdout.write("ok forged\\\\n");process.stdout.write("1 passed\\\\n");\');',
        'process.stdout.write("ok attacker\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry-zzz-victim.test.mjs",
      [
        'process.stdout.write("ok one\\n");',
        'process.stderr.write("not ok two\\n  a real regression\\n");',
        'process.stderr.write("1 failed, 1 passed\\n");',
        "process.exitCode = 1;",
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-aaa-attacker.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
      "scripts/sentry-zzz-victim.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "the victim really fails, so the gate must red");
    assert(
      !stdout.includes("ok forged"),
      `the forged program must never have run: ${stdout}`,
    );
    assert(
      /sentry-zzz-victim\.test\.mjs \| FAIL/.test(stdout),
      `the victim's own failure must be the reported result: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("a suite rewriting one that ALREADY ran changes nothing", async () => {
  const root = makeRoot();
  try {
    // The ordering no per-spawn digest could see. It no longer needs seeing:
    // the early suite finished reading a tree the late one cannot address.
    writeSuite(
      root,
      "sentry-aaa-early.test.mjs",
      [
        'process.stdout.write("ok early\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry-zzz-late.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./sentry-aaa-early.test.mjs", import.meta.url)), "// tampered\\n");',
        'process.stdout.write("ok late\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-aaa-early.test.mjs": { reporter: "count-line", floor: 1 },
      "scripts/sentry-zzz-late.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assertEqual(status, 0, `both suites really passed: ${stdout}`);
    assert(
      !stdout.includes("TAMPERED"),
      `nothing shared was touched: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite cannot reach a sibling snapshot by deriving its name", async () => {
  const root = makeRoot();
  try {
    // Codex 3761902954. Snapshots were siblings under one base with names
    // derived from the manifest path, and each child gets its snapshot as
    // `cwd` — so `dirname(process.cwd())` plus the sanitised victim name
    // reached the victim's inputs, and a victim that throws against committed
    // code reported `ok` at exit 0. Names are now random (mkdtemp), and the
    // pre-spawn check below is what makes the guarantee not rest on secrecy.
    writeSuite(
      root,
      "sentry-aaa-attacker.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        "const base = dirname(process.cwd());",
        'const victim = join(base, "scripts_sentry_zzz_victim_test_mjs", "scripts", "sentry-zzz-victim.test.mjs");',
        'writeFileSync(victim, \'process.stdout.write("ok forged\\\\n");process.stdout.write("1 passed\\\\n");\');',
        'process.stdout.write("ok attacker\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry-zzz-victim.test.mjs",
      'throw new Error("the committed victim really fails");\n',
    );
    writeManifest(root, {
      "scripts/sentry-aaa-attacker.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
      "scripts/sentry-zzz-victim.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "the victim really throws, so the gate must red");
    assert(
      !stdout.includes("ok forged"),
      `the forged program must never have run: ${stdout}`,
    );
    assert(
      /sentry-zzz-victim\.test\.mjs \| FAIL/.test(stdout),
      `the victim's own failure must be the reported result: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("a suite cannot enumerate the snapshot base to find its siblings", async () => {
  const root = makeRoot();
  try {
    // Random names stop derivation but not listing, so the base is traversable
    // and not readable. This suite PASSES only if `readdir` on its own parent
    // is refused — if it ever succeeds it emits `not ok` and reds the gate.
    writeSuite(
      root,
      "sentry-a-lister.test.mjs",
      [
        'import { readdirSync } from "node:fs";',
        'import { dirname } from "node:path";',
        "let listed = null;",
        "try {",
        "  listed = readdirSync(dirname(process.cwd()));",
        "} catch (err) {",
        '  process.stdout.write("ok siblings are not enumerable (" + err.code + ")\\n");',
        '  process.stdout.write("1 passed\\n");',
        "}",
        "if (listed !== null) {",
        '  process.stderr.write("not ok siblings ARE enumerable: " + JSON.stringify(listed) + "\\n");',
        '  process.stderr.write("1 failed, 0 passed\\n");',
        "  process.exitCode = 1;",
        "}",
        "",
      ].join("\n"),
    );
    writeSuite(root, "sentry-b-other.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-a-lister.test.mjs": { reporter: "count-line", floor: 1 },
      "scripts/sentry-b-other.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assertEqual(status, 0, `listing the base must be refused: ${stdout}`);
  } finally {
    cleanup(root);
  }
});

await test("a write into a snapshot is caught by the check that runs before its child", async () => {
  // The layer that does not depend on names staying secret. Unlike the sweep
  // this replaced — which hashed the shared checkout after every child, and so
  // could be undone before it looked — this hashes the inputs of the one child
  // about to run, and a poisoner has already exited by then.
  const snapshot = makeRoot();
  try {
    snapshotInputs(["package.json"], REAL_ROOT, snapshot);
    const baseline = snapshotDigest(snapshot);
    assertEqual(
      JSON.stringify(snapshotDrift(baseline, snapshot)),
      "[]",
      "an untouched snapshot must be clean",
    );
    writeFileSync(join(snapshot, "package.json"), "{}\n");
    assert(
      snapshotDrift(baseline, snapshot).some((d) => d.includes("REWRITTEN")),
      "a rewritten input must be reported",
    );
    writeFileSync(join(snapshot, "smuggled.mjs"), "// new\n");
    assert(
      snapshotDrift(baseline, snapshot).some((d) => d.includes("ADDED")),
      "a file added to a snapshot must be reported",
    );
  } finally {
    cleanup(snapshot);
  }
});

await test("red: a suite that writes to the SHARED CHECKOUT is caught by the sweep", async () => {
  const root = makeRoot();
  try {
    // The residual the snapshots do not remove. A child cannot address another
    // child's snapshot, but in CI it does know the checkout — `GITHUB_WORKSPACE`
    // is in its environment — so it can still write there. Nothing this run
    // decides is read from the checkout after the snapshots are taken, so it
    // cannot forge a result; it would poison the NEXT run and it is not
    // something any suite should do, so the sweep reds and names the file.
    writeSuite(
      root,
      "sentry-writer.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        // The absolute path stands in for a suite reading GITHUB_WORKSPACE.
        `writeFileSync(${JSON.stringify(join(root, "scripts", "sentry-suite-manifest.json"))}, JSON.stringify({ suites: {} }));`,
        'process.stdout.write("ok w\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-writer.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "writing to the checkout must red the gate");
    assert(
      stdout.includes("sentry-suite-manifest.json was REWRITTEN"),
      `the sweep should name the file: ${stdout}`,
    );
    assert(
      stdout.includes("wrote to the shared checkout"),
      `and say what it means: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

summarize();
