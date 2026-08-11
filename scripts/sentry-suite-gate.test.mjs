#!/usr/bin/env node
/**
 * The sentry-suite gate's own suite (issue #1779, ADR 0062).
 *
 * Named `sentry-*.test.mjs` on purpose: `findSentrySuites` enumerates it and the
 * real gate runs it, so neutering the runner now also requires faking THIS
 * suite's `ok` lines and `<n> passed` summary — the same bar every other suite
 * clears. It uses the homegrown count-line harness so the gate parses it as a
 * `count-line` reporter.
 *
 * Each negative path builds a throwaway fixture repo root and proves the gate
 * goes red for exactly one reason; the green controls prove it stays green when
 * nothing is wrong. The R1 (`NODE_OPTIONS=--import…process.exit(0)`) proof runs
 * at the `runSuite` boundary, where the `env -u` latch lives, because setting
 * NODE_OPTIONS on the whole gate would (correctly) trip its refuse-to-start
 * guard — which is a separate proof below.
 *
 * Dependency-free: only `node:` builtins plus the gate module, so the CI
 * `sentry-suites` job runs it with no install.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestDrift,
  digestFile,
  digestWatchSet,
  findSentrySuites,
  judgeSuite,
  parseCountLine,
  parseNodeTest,
  reconcile,
  runSuite,
} from "./sentry-suite-gate.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message =
      err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || "not equal"}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

const GATE = fileURLToPath(new URL("./sentry-suite-gate.mjs", import.meta.url));
const EVIL = "--import=data:text/javascript,process.exit(0)";

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "sentry-gate-fixture-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeSuite(root, name, body) {
  writeFileSync(join(root, "scripts", name), body);
}

function writeManifest(root, suites) {
  writeFileSync(
    join(root, "scripts", "sentry-suite-manifest.json"),
    JSON.stringify({ suites }, null, 2),
  );
}

/** A count-line fixture: `count` `ok` lines and a matching `<count> passed`. */
function countLineSuite(count) {
  return [
    `for (let i = 0; i < ${count}; i += 1) {`,
    `  process.stdout.write("ok case " + i + "\\n");`,
    `}`,
    `process.stdout.write("${count} passed\\n");`,
    ``,
  ].join("\n");
}

/** A node:test fixture with `count` trivial passing cases. */
function nodeTestSuite(count) {
  return [
    `import { test } from "node:test";`,
    ...Array.from({ length: count }, (_, i) => `test("case ${i}", () => {});`),
    ``,
  ].join("\n");
}

/** Spawn the real gate against a fixture root. */
function runGate(root, extraEnv = {}) {
  const child = spawnSync("node", [GATE], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SENTRY_SUITE_GATE_ROOT: root, ...extraEnv },
  });
  return {
    status: child.status,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
  };
}

// ── Green controls ───────────────────────────────────────────────────────────

await test("green: a matching manifest of passing count-line suites exits 0", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeSuite(root, "sentry-beta.test.mjs", countLineSuite(5));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
      "scripts/sentry-beta.test.mjs": { reporter: "count-line", floor: 5 },
    });
    const { status, stdout, stderr } = runGate(root);
    assertEqual(status, 0, `expected green exit\n${stdout}\n${stderr}`);
    assert(stdout.includes("| ok |"), "table should mark suites ok");
  } finally {
    cleanup(root);
  }
});

await test("green: a node:test reporter suite is parsed and asserted", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-nodetest.test.mjs", nodeTestSuite(4));
    writeManifest(root, {
      "scripts/sentry-nodetest.test.mjs": {
        reporter: "node-test",
        floor: 4,
      },
    });
    const { status, stdout, stderr } = runGate(root);
    assertEqual(
      status,
      0,
      `expected green node:test exit\n${stdout}\n${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── (a) truncated / emptied / hollow ─────────────────────────────────────────

await test("red (a): an emptied suite fails closed — no summary to parse", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", "");
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
    });
    const { status, stdout, stderr } = runGate(root);
    assert(status !== 0, "an emptied suite must red the gate");
    assert(
      (stdout + stderr).includes("summary"),
      "should cite the missing summary (parse failure)",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (a): a hollow suite whose summary overcounts fails pass==lines", async () => {
  const root = makeRoot();
  try {
    // One real `ok` line, a summary claiming five — the R2 skew class.
    writeSuite(
      root,
      "sentry-alpha.test.mjs",
      [
        'process.stdout.write("ok only one\\n");',
        'process.stdout.write("5 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a hollow suite must red the gate");
    assert(
      stdout.includes("per-case line"),
      "should cite the pass != per-case-line skew",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (a): a failure emitted AFTER the summary still fails the gate", async () => {
  const root = makeRoot();
  try {
    // Codex 3759734266, verbatim. The summary is printed before a later failing
    // test, so it reports fail=0 and pass=1 with exactly one `ok` line. Every
    // count-based check agrees with itself; only reconciling the FAILURE side
    // against emitted lines catches it. Before the fix this returned exit 0 with
    // `pass=1 floor=1 lines=1` — the gate reproducing the defect it exists to
    // catch.
    writeSuite(
      root,
      "sentry-alpha.test.mjs",
      [
        'process.stdout.write("ok before\\n");',
        'process.stdout.write("1 passed\\n");',
        'process.stdout.write("not ok failure after summary\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a failure after the summary must red the gate");
    assert(
      stdout.includes("failure line(s) emitted"),
      "should cite the emitted failure line, not just the summary",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (a): a `not ok` on stderr fails even when the summary says fail=0", async () => {
  const root = makeRoot();
  try {
    // The real harness writes `not ok` to stderr, so the reconciliation has to
    // read both streams, not stdout alone.
    writeSuite(
      root,
      "sentry-alpha.test.mjs",
      [
        'process.stdout.write("ok one\\n");',
        'process.stderr.write("not ok two\\n  boom\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status } = runGate(root);
    assert(status !== 0, "a stderr `not ok` must red the gate");
  } finally {
    cleanup(root);
  }
});

await test("red (a): a node:test suite that really fails is rejected", async () => {
  const root = makeRoot();
  try {
    writeSuite(
      root,
      "sentry-nodetest.test.mjs",
      [
        'import { test } from "node:test";',
        'test("a", () => {});',
        'test("b", () => { throw new Error("boom"); });',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-nodetest.test.mjs": { reporter: "node-test", floor: 1 },
    });
    const { status } = runGate(root);
    assert(status !== 0, "a failing node:test suite must red the gate");
  } finally {
    cleanup(root);
  }
});

// ── (a2) suite-rewrite: one child must not be able to forge another's result ──

await test("red: an earlier suite rewriting a later one is caught before it runs", async () => {
  const root = makeRoot();
  try {
    // Codex 3759964336. Every child shares the writable checkout, so without
    // digest verification an alphabetically earlier suite can overwrite a later
    // FAILING suite with a program emitting the expected `ok` lines and a
    // matching summary — and both report passing at exit 0, voiding the gate's
    // central claim that each result came from that suite.
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
    assert(status !== 0, "a rewritten suite must red the gate");
    assert(stdout.includes("TAMPERED"), "should mark the suite tampered");
    assert(
      stdout.includes("sentry-zzz-victim.test.mjs was REWRITTEN"),
      "should name the rewritten suite",
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite rewriting one that ALREADY ran is caught by the final sweep", async () => {
  const root = makeRoot();
  try {
    // The ordering no per-spawn check can see: the attacker runs last and
    // rewrites an earlier suite after its result was recorded. Only re-verifying
    // every digest after the last child catches it.
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
    assert(status !== 0, "a post-hoc rewrite must red the gate");
    assert(
      stdout.includes("sentry-aaa-early.test.mjs was REWRITTEN"),
      "the sweep should name the suite rewritten after it ran",
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite rewriting the manifest is caught", async () => {
  const root = makeRoot();
  try {
    writeSuite(
      root,
      "sentry-m.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./sentry-suite-manifest.json", import.meta.url)), JSON.stringify({ suites: {} }));',
        'process.stdout.write("ok m\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-m.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "rewriting the manifest must red the gate");
    assert(
      stdout.includes("sentry-suite-manifest.json was REWRITTEN"),
      "should name the manifest",
    );
  } finally {
    cleanup(root);
  }
});

await test("digestDrift reports created, deleted, and rewritten files", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-a.test.mjs", "// original\n");
    const baseline = new Map([
      [
        "scripts/sentry-a.test.mjs",
        digestFile(join(root, "scripts/sentry-a.test.mjs")),
      ],
      ["scripts/sentry-gone.test.mjs", "deadbeef"],
      ["scripts/sentry-new.test.mjs", null],
    ]);
    writeSuite(root, "sentry-a.test.mjs", "// rewritten\n");
    writeSuite(root, "sentry-new.test.mjs", "// appeared\n");
    const drift = digestDrift(baseline, root);
    assertEqual(drift.length, 3, `expected three drifts: ${drift.join("; ")}`);
    assert(
      drift.some((d) => d.includes("REWRITTEN")) &&
        drift.some((d) => d.includes("DELETED")) &&
        drift.some((d) => d.includes("CREATED")),
      `expected one of each: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("digestDrift is silent when nothing changed", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-a.test.mjs", "// stable\n");
    const baseline = digestWatchSet(["scripts/sentry-a.test.mjs"], root);
    assertEqual(digestDrift(baseline, root).length, 0, "no drift expected");
  } finally {
    cleanup(root);
  }
});

// ── (b) R1: NODE_OPTIONS neutering, and the env -u latch that defeats it ──────

await test("red (b): NODE_OPTIONS=--import…exit(0) neuters a plain `node` run (attack is real)", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    const child = spawnSync(
      "node",
      [join(root, "scripts", "sentry-alpha.test.mjs")],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: EVIL } },
    );
    assertEqual(child.status, 0, "the neutered run exits 0");
    assertEqual(
      (child.stdout || "").trim(),
      "",
      "the neutered run emits nothing",
    );
  } finally {
    cleanup(root);
  }
});

await test("green (b): runSuite's `env -u` strips an ambient NODE_OPTIONS so the suite really runs", async () => {
  const root = makeRoot();
  const saved = process.env.NODE_OPTIONS;
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    const entry = { reporter: "count-line", floor: 3 };
    process.env.NODE_OPTIONS = EVIL;
    const result = runSuite("scripts/sentry-alpha.test.mjs", entry, { root });
    const reasons = judgeSuite(result, entry);
    assertEqual(result.exit, 0, "latched suite exits 0");
    assertEqual(result.pass, 3, "latched suite reports its real 3 passes");
    assertEqual(result.caseLines, 3, "latched suite emitted 3 per-case lines");
    assertEqual(
      reasons.length,
      0,
      `latched suite passes the gate: ${reasons.join("; ")}`,
    );
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
    cleanup(root);
  }
});

// ── (c) set-equality drift, both directions ──────────────────────────────────

await test("red (c): a suite on disk missing from the manifest fails set-equality with a patch", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeSuite(root, "sentry-beta.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an unmanifested on-disk suite must red the gate");
    // The message must name the manifest FILE and how to fix it, not just fail:
    // a contributor who splits a suite into two files must see the cause.
    assert(
      stderr.includes("scripts/sentry-suite-manifest.json"),
      "names the manifest file to edit",
    );
    assert(
      stderr.includes("scripts/sentry-beta.test.mjs"),
      "names the unmanifested suite",
    );
    assert(
      stderr.includes('add a "scripts/sentry-beta.test.mjs" entry'),
      "tells the contributor to add the entry",
    );
    assert(
      stderr.includes("Apply this patch to scripts/sentry-suite-manifest.json"),
      "prints the JSON patch to apply, naming the manifest",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (c): a manifest entry with no file on disk fails set-equality", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
      "scripts/sentry-ghost.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "a phantom manifest entry must red the gate");
    assert(
      stderr.includes('remove the "scripts/sentry-ghost.test.mjs" entry'),
      "tells the contributor to remove the phantom entry",
    );
    assert(
      stderr.includes("scripts/sentry-suite-manifest.json"),
      "names the manifest file to edit",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (c): a renamed suite is reported as a rename, naming the manifest", async () => {
  const root = makeRoot();
  try {
    // sentry-beta on disk, sentry-alpha in the manifest = one add + one remove.
    writeSuite(root, "sentry-beta.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "a rename that skips the manifest must red the gate");
    assert(
      stderr.includes("looks like a rename"),
      "recognizes the single add + single remove as a rename",
    );
    assert(
      stderr.includes(
        "scripts/sentry-alpha.test.mjs → scripts/sentry-beta.test.mjs",
      ),
      "names both sides of the rename",
    );
    assert(
      stderr.includes("scripts/sentry-suite-manifest.json"),
      "names the manifest file to edit",
    );
  } finally {
    cleanup(root);
  }
});

await test("red (c): an unknown reporter names the manifest and the valid reporters", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "", floor: 3 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "a blank reporter must red the gate");
    assert(
      stderr.includes("scripts/sentry-suite-manifest.json"),
      "names the manifest file to edit",
    );
    assert(
      stderr.includes('"count-line"') && stderr.includes('"node-test"'),
      "lists the valid reporter values",
    );
  } finally {
    cleanup(root);
  }
});

// ── (d) the gate refuses to start under a tamper env ─────────────────────────

await test("red (d): the gate refuses to start when NODE_OPTIONS is set in its own env", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
    });
    const { status, stderr } = runGate(root, { NODE_OPTIONS: "--no-warnings" });
    assert(status !== 0, "NODE_OPTIONS on the gate must refuse to start");
    assert(stderr.includes("refusing to start"), "explains the refusal");
    assert(stderr.includes("NODE_OPTIONS"), "names the offending variable");
  } finally {
    cleanup(root);
  }
});

await test("red (d): the gate refuses to start when NODE_PATH is set in its own env", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(3));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 3 },
    });
    const { status, stderr } = runGate(root, { NODE_PATH: "/nonexistent" });
    assert(status !== 0, "NODE_PATH on the gate must refuse to start");
    assert(stderr.includes("NODE_PATH"), "names the offending variable");
  } finally {
    cleanup(root);
  }
});

// ── (e) floor breach ─────────────────────────────────────────────────────────

await test("red (e): a suite reporting fewer passes than its floor reds the gate", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(2));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 5 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a floor breach must red the gate");
    assert(stdout.includes("< floor 5"), "cites the floor breach");
    assert(
      stdout.includes(
        "lower the floor for scripts/sentry-alpha.test.mjs in scripts/sentry-suite-manifest.json to 2",
      ),
      "names the suite, the manifest file, and the measured value to set",
    );
  } finally {
    cleanup(root);
  }
});

// ── Parser and reconciliation contracts (pure) ───────────────────────────────

await test("parseCountLine ignores prose containing 'N failed' and reads the anchored summary", async () => {
  const stdout = "ok a\nok b\nlog: 51 failed attempts were retried\n2 passed\n";
  const r = parseCountLine(stdout, "");
  assertEqual(r.pass, 2, "pass");
  assertEqual(r.fail, 0, "fail");
  assertEqual(r.caseLines, 2, "caseLines");
});

await test("parseCountLine reads the failure summary off stderr", async () => {
  const r = parseCountLine("ok a\n", "not ok b\n  boom\n1 failed, 1 passed\n");
  assertEqual(r.pass, 1, "pass");
  assertEqual(r.fail, 1, "fail");
  assertEqual(r.caseLines, 1, "caseLines");
});

await test("parseCountLine reads the autofix `<n> passed, <m> failed` dialect", async () => {
  const r = parseCountLine("ok a\nok b\n\n2 passed, 0 failed\n", "");
  assertEqual(r.pass, 2, "pass");
  assertEqual(r.fail, 0, "fail");
  assertEqual(r.caseLines, 2, "caseLines");
});

await test("parseCountLine throws when there is no summary line (fail closed)", async () => {
  let threw = false;
  try {
    parseCountLine("ok a\nok b\n", "");
  } catch {
    threw = true;
  }
  assert(threw, "a missing summary must throw");
});

await test("parseCountLine counts emitted `not ok` lines across both streams", async () => {
  const r = parseCountLine("ok a\nnot ok b\n1 passed\n", "not ok c\n");
  assertEqual(r.pass, 1, "pass");
  assertEqual(r.fail, 0, "summary fail");
  assertEqual(r.failLines, 2, "failLines counts stdout + stderr");
});

await test("judgeSuite rejects a summary that disagrees with emitted failures", async () => {
  const reasons = judgeSuite(
    { exit: 0, pass: 1, fail: 0, caseLines: 1, failLines: 1 },
    { floor: 1 },
  );
  assert(reasons.length > 0, "must reject");
  assert(
    reasons.some((r) => r.includes("failure line(s) emitted")),
    `should cite the emitted failure: ${reasons.join("; ")}`,
  );
});

await test("judgeSuite accepts a clean count-line result", async () => {
  const reasons = judgeSuite(
    { exit: 0, pass: 3, fail: 0, caseLines: 3, failLines: 0 },
    { floor: 3 },
  );
  assertEqual(reasons.length, 0, `expected no reasons: ${reasons.join("; ")}`);
});

await test("judgeSuite does not demand exact failure-line equality for node:test", async () => {
  // The spec reporter repeats each failure under a `✖ failing tests:` header,
  // so one failure emits three `✖` lines; only the zero case is exact.
  const reasons = judgeSuite(
    {
      exit: 0,
      pass: 2,
      fail: 0,
      caseLines: 2,
      failLines: 0,
      exactFailLines: false,
    },
    { floor: 2 },
  );
  assertEqual(reasons.length, 0, `expected no reasons: ${reasons.join("; ")}`);
});

await test("parseNodeTest reads `ℹ pass`/`ℹ fail` and counts ✔ lines", async () => {
  const out = "✔ a (0.1ms)\n✔ b (0.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n";
  const r = parseNodeTest(out, "");
  assertEqual(r.pass, 2, "pass");
  assertEqual(r.fail, 0, "fail");
  assertEqual(r.caseLines, 2, "caseLines");
});

await test("reconcile is order-independent and reports both directions", async () => {
  const r = reconcile(
    ["scripts/sentry-b.test.mjs", "scripts/sentry-a.test.mjs"],
    ["scripts/sentry-a.test.mjs", "scripts/sentry-c.test.mjs"],
  );
  assert(!r.equal, "sets differ");
  assertEqual(
    JSON.stringify(r.onDiskNotInManifest),
    JSON.stringify(["scripts/sentry-b.test.mjs"]),
    "onDiskNotInManifest",
  );
  assertEqual(
    JSON.stringify(r.inManifestNotOnDisk),
    JSON.stringify(["scripts/sentry-c.test.mjs"]),
    "inManifestNotOnDisk",
  );
});

await test("findSentrySuites returns repo-relative, sorted sentry-*.test.mjs paths", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-b.test.mjs", "");
    writeSuite(root, "sentry-a.test.mjs", "");
    writeSuite(root, "not-a-suite.mjs", "");
    const found = findSentrySuites(join(root, "scripts"));
    assertEqual(
      JSON.stringify(found),
      JSON.stringify([
        "scripts/sentry-a.test.mjs",
        "scripts/sentry-b.test.mjs",
      ]),
      "enumeration",
    );
  } finally {
    cleanup(root);
  }
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
