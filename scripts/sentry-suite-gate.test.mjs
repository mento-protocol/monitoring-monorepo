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
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import {
  cleanup,
  countLineSuite,
  EVIL,
  makeHarness,
  makeRoot,
  nodeTestSuite,
  runGate,
  writeManifest,
  writeSuite,
} from "./sentry-suite-gate-fixtures.mjs";
import {
  findSentrySuites,
  judgeSuite,
  parseCountLine,
  parseNodeTest,
  reconcile,
  runSuite,
  staticImports,
  verifyExemptRoute,
} from "./sentry-suite-gate.mjs";

const { test, assert, assertEqual, summarize } = makeHarness();

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

// ── (a3) manifest schema: an allowlist, so unknown fields cannot steer a run ──

/** A suite that always throws, so any "green" verdict on it is a false green. */
const THROWING_SUITE = 'throw new Error("this suite must fail the gate");\n';

await test("red: `nodeArgs` cannot be used to stop a suite running", async () => {
  const root = makeRoot();
  try {
    // Codex 3760239539. nodeArgs is spread verbatim into node's argv, so
    // `--eval` made node treat the suite PATH as a positional argument and never
    // run it: the throwing suite below was judged `pass=1 floor=1 lines=1`, exit 0.
    writeSuite(root, "sentry-broken.test.mjs", THROWING_SUITE);
    writeManifest(root, {
      "scripts/sentry-broken.test.mjs": {
        reporter: "count-line",
        floor: 1,
        nodeArgs: ["--eval", "console.log('ok fake'); console.log('1 passed')"],
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an arbitrary nodeArgs must red the gate");
    assert(
      stderr.includes('the only supported value is ["--test"]'),
      `should name the one supported value: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: `exempt` cannot be used to skip an arbitrary suite", async () => {
  const root = makeRoot();
  try {
    // Codex 3760239548. Exemption skips execution AND every count check, and the
    // route was only substring-matched, so a comment naming the path plus an
    // `echo` script satisfied it — the throwing suite reported `exempt`, exit 0.
    writeSuite(root, "sentry-broken.test.mjs", THROWING_SUITE);
    writeFileSync(
      join(root, "scripts", "fake-importer.mjs"),
      "// a comment that merely mentions ./sentry-broken.test.mjs\n",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { fake: "echo scripts/fake-importer.mjs" } }),
    );
    writeManifest(root, {
      "scripts/sentry-broken.test.mjs": {
        reporter: "exit-only",
        exempt: {
          runBy: "some-job",
          via: "pnpm fake",
          importer: "scripts/fake-importer.mjs",
        },
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "exempting an arbitrary suite must red the gate");
    assert(
      stderr.includes("exemption is reserved for"),
      `should reserve exemption to the one suite: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: an unrecognised manifest field is rejected outright", async () => {
  const root = makeRoot();
  try {
    // The inversion itself: nobody wrote down "reject `env`". The schema is an
    // allowlist, so a field it does not carry cannot influence a run whatever a
    // future edit calls it.
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": {
        reporter: "count-line",
        floor: 1,
        env: { NODE_OPTIONS: "--import=./x.mjs" },
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an unknown entry field must red the gate");
    assert(
      stderr.includes('unrecognised field "env"'),
      `should name the field: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: an unrecognised top-level manifest key is rejected", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(1));
    writeFileSync(
      join(root, "scripts", "sentry-suite-manifest.json"),
      JSON.stringify({
        suites: {
          "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
        },
        defaults: { nodeArgs: ["--eval", "0"] },
      }),
    );
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an unknown top-level key must red the gate");
    assert(
      stderr.includes("unrecognised top-level key"),
      `should name the key: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("staticImports reports V8's module requests, not text that looks like one", async () => {
  // Both regexes this replaced produced a P1. Unanchored, the scanner counted
  // `import` inside a string literal; line-anchored to fix that, it stopped
  // seeing ordinary multiline imports. This asserts the whole grid at once, so
  // a future round cannot fix one column by breaking another.
  const root = makeRoot();
  try {
    writeSuite(
      root,
      "probe.mjs",
      [
        '// import "./commented-out.mjs";',
        '/* import "./blocked.mjs"; */',
        "const embedded = 'import \"./in-a-string.mjs\";';",
        'import "./side-effect.mjs";',
        "import {",
        "  a,",
        "  b,",
        '} from "./multiline.mjs";',
        'export { c } from "./reexport.mjs";',
        'export * from "./star.mjs";',
        'const dynamic = await import("./dynamic.mjs");',
        'if (false) import("./unreached.mjs");',
        "void embedded;",
        "void dynamic;",
        "void a;",
        "void b;",
        "",
      ].join("\n"),
    );
    assertEqual(
      JSON.stringify(staticImports(join(root, "scripts", "probe.mjs")).sort()),
      JSON.stringify(
        [
          "./multiline.mjs",
          "./reexport.mjs",
          "./side-effect.mjs",
          "./star.mjs",
        ].sort(),
      ),
      "multiline and re-export in; comment, string literal and dynamic import out",
    );
  } finally {
    cleanup(root);
  }
});

/** A fixture root whose exempt route is intact, ready to be broken one way. */
function routeRoot({ importer, tfTest }) {
  const root = makeRoot();
  writeSuite(
    root,
    "sentry-provider-contract.test.mjs",
    "// the exempt suite\n",
  );
  writeSuite(
    root,
    "tf-stacks.test.mjs",
    importer ?? 'import "./sentry-provider-contract.test.mjs";\n',
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { "tf:test": tfTest ?? "node scripts/tf-stacks.test.mjs" },
    }),
  );
  return root;
}

const ROUTE_EXEMPT = {
  runBy: "production-infra-contract",
  via: "pnpm tf:test",
  importer: "scripts/tf-stacks.test.mjs",
};
const ROUTE_SUITE = "scripts/sentry-provider-contract.test.mjs";

await test("green: the committed exemption shape verifies", async () => {
  const root = routeRoot({});
  try {
    const reasons = verifyExemptRoute(ROUTE_SUITE, ROUTE_EXEMPT, root);
    assertEqual(
      JSON.stringify(reasons),
      "[]",
      `an intact route must produce no blockers: ${reasons.join("; ")}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a dynamic import does not prove the exempt route", async () => {
  // Codex 3761232894. The regex recorded the specifier inside
  // `if (false) import("…")`, so `verifyExemptRoute` returned no blockers for an
  // importer that never loads the suite — `pnpm tf:test` would run and the
  // provider assertions would never execute, in either job.
  const root = routeRoot({
    importer: 'if (false) import("./sentry-provider-contract.test.mjs");\n',
  });
  try {
    const reasons = verifyExemptRoute(ROUTE_SUITE, ROUTE_EXEMPT, root);
    assert(
      reasons.some((r) => r.includes("has no static import of")),
      `an unreached dynamic import must not satisfy the route: ${JSON.stringify(reasons)}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: an alias that can skip or mask the importer breaks the route", async () => {
  // Codex 3761232900. `true || node …` never runs the importer; `node … || true`
  // swallows its failures. Both left the required jobs green with no successful
  // provider suite anywhere. The alias must be one exact command.
  for (const tfTest of [
    "true || node scripts/tf-stacks.test.mjs",
    "node scripts/tf-stacks.test.mjs || true",
    "node scripts/tf-stacks.test.mjs; true",
    "node scripts/tf-stacks.test.mjs\ntrue",
    "node scripts/tf-stacks.test.mjs --test-name-pattern=nothing",
    "echo node scripts/tf-stacks.test.mjs",
  ]) {
    const root = routeRoot({ tfTest });
    try {
      const reasons = verifyExemptRoute(ROUTE_SUITE, ROUTE_EXEMPT, root);
      assert(
        reasons.some((r) => r.includes("and nothing else")),
        `\`${tfTest}\` must break the route: ${JSON.stringify(reasons)}`,
      );
    } finally {
      cleanup(root);
    }
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

summarize();
