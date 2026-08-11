#!/usr/bin/env node
/**
 * The sentry-suite gate's INTEGRITY suite (issue #1779, ADR 0062).
 *
 * Split out of scripts/sentry-suite-gate.test.mjs when that file crossed the
 * repo's 1,000-line hard cap, which the checker's own file-size pin now
 * enforces on it. The split is behaviour-neutral: no case was renamed or
 * rewritten, only moved.
 *
 * This half owns the claims about a gate RUN being trustworthy as a whole,
 * rather than about parsing one suite's output:
 *
 *   - one child cannot forge another's result (digest verification, before each
 *     spawn and again after the last one);
 *   - the watch set EQUALS the inputs the gate consults to decide, derived from
 *     the manifest rather than hand-listed;
 *   - a suite created mid-run is caught by re-enumeration;
 *   - an exemption's route evidence cannot be rewritten by an earlier suite;
 *   - fixture gates never write their tables into the real step summary.
 *
 * Named `sentry-*.test.mjs` on purpose, like its sibling: `findSentrySuites`
 * enumerates it, so the gate runs it and holds it to a floor like any other
 * suite. Dependency-free — only `node:` builtins and the two local modules.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

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
  digestDrift,
  digestFile,
  digestWatchSet,
  gateInputs,
  successAttestation,
} from "./sentry-suite-gate.mjs";

const { test, assert, assertEqual, summarize } = makeHarness();

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
    const baseline = digestWatchSet(
      {
        suites: {
          "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
        },
      },
      root,
    );
    assertEqual(digestDrift(baseline, root).length, 0, "no drift expected");
  } finally {
    cleanup(root);
  }
});

await test("a gate run writes exactly ONE table to the step summary", async () => {
  const root = makeRoot();
  try {
    // Codex 3760509528. Fixture gates inherited the real GITHUB_STEP_SUMMARY
    // and appended to it: 94 lines across 11 tables, 9 `failed the gate` rows
    // and 4 `TAMPERED` rows, in a job that succeeded. The summary is the only
    // operator-facing output this job produces, so fixture tables in it are a
    // correctness problem, not noise. One gate run must produce one table.
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(2));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 2 },
    });
    const { status, summary } = runGate(root);
    assertEqual(status, 0, "control run should pass");
    const tables = (summary.match(/^## Sentry-suite gate$/gm) || []).length;
    assertEqual(
      tables,
      1,
      `expected exactly one table, summary was:\n${summary}`,
    );
    assert(
      summary.includes("scripts/sentry-alpha.test.mjs"),
      "the table should be the real one for this run",
    );
  } finally {
    cleanup(root);
  }
});

await test("fixture gates never write to the ambient step summary", async () => {
  const root = makeRoot();
  const ambient = join(root, "ambient-summary.md");
  const saved = process.env.GITHUB_STEP_SUMMARY;
  try {
    writeFileSync(ambient, "");
    // Simulate running inside the sentry-suites job, where this points at the
    // real summary; runGate must redirect its children away from it.
    process.env.GITHUB_STEP_SUMMARY = ambient;
    writeSuite(root, "sentry-alpha.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { summary } = runGate(root);
    assert(
      summary.includes("## Sentry-suite gate"),
      "the fixture still wrote a summary",
    );
    assertEqual(
      readFileSync(ambient, "utf8"),
      "",
      "the ambient summary must be untouched by a fixture gate",
    );
  } finally {
    if (saved === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = saved;
    cleanup(root);
  }
});

await test("the watch set equals every input the gate reads to decide", async () => {
  // The general form of Codex 3760509524 and 3760861940: the watch set was
  // decided three times by listing files that felt load-bearing, and missed one
  // each time. It is now DERIVED — from the manifest AND from each suite's
  // transitive first-party imports — so any entry that brings a new decision
  // input brings it into the watch set too.
  const root = makeRoot();
  try {
    // A suite importing a helper that imports a second helper: the closure must
    // reach BOTH, or a rewrite of the deeper one goes unnoticed.
    writeSuite(root, "sentry-a.test.mjs", 'import "./helper-one.mjs";\n');
    writeFileSync(
      join(root, "scripts", "helper-one.mjs"),
      'import "./helper-two.mjs";\nexport const A = 1;\n',
    );
    writeFileSync(
      join(root, "scripts", "helper-two.mjs"),
      "export const B = 2;\n",
    );
    writeFileSync(
      join(root, "scripts", "sentry-provider-contract.test.mjs"),
      "// exempt\n",
    );
    writeFileSync(
      join(root, "scripts", "tf-stacks.test.mjs"),
      'import "./sentry-provider-contract.test.mjs";\n',
    );
    const manifest = {
      suites: {
        "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
        "scripts/sentry-provider-contract.test.mjs": {
          reporter: "exit-only",
          exempt: {
            runBy: "production-infra-contract",
            via: "pnpm tf:test",
            importer: "scripts/tf-stacks.test.mjs",
          },
        },
      },
    };
    assertEqual(
      JSON.stringify(gateInputs(manifest, root)),
      JSON.stringify([
        "package.json",
        "scripts/helper-one.mjs",
        "scripts/helper-two.mjs",
        "scripts/sentry-a.test.mjs",
        "scripts/sentry-provider-contract.test.mjs",
        "scripts/sentry-suite-gate.mjs",
        "scripts/sentry-suite-manifest.json",
        "scripts/tf-stacks.test.mjs",
      ]),
      "the derived input set, including the transitive import closure",
    );
    // And the digest baseline must watch exactly that set, not a subset.
    const watched = [...digestWatchSet(manifest, root).keys()].sort();
    assertEqual(
      JSON.stringify(watched),
      JSON.stringify(gateInputs(manifest, root)),
      "the watch set must equal the derived inputs",
    );
  } finally {
    cleanup(root);
  }
});

await test("gateInputs refuses to run without a root rather than deriving less", async () => {
  // Omitting the root would make every import closure read nothing and silently
  // shrink the set back to the pre-closure one — the regression the closure
  // exists to prevent, arriving as a convenience default.
  let threw = false;
  try {
    gateInputs({ suites: {} });
  } catch {
    threw = true;
  }
  assert(threw, "a missing root must throw, not degrade");
});

await test("red: a suite rewriting another suite's imported helper is caught", async () => {
  const root = makeRoot();
  try {
    // Codex 3760861940. The helper is not a suite, so no digest covered it
    // before the closure: `alpha` rewrote it, and `beta` — which FAILS against
    // the committed helper — reported ok at exit 0.
    writeSuite(
      root,
      "sentry-alpha.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./victim-helper.mjs", import.meta.url)),',
        "  'export const VALUE = \"forged\";\\n');",
        'process.stdout.write("ok alpha\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry-beta.test.mjs",
      [
        'import { VALUE } from "./victim-helper.mjs";',
        'if (VALUE === "forged") {',
        '  process.stdout.write("ok beta\\n");',
        '  process.stdout.write("1 passed\\n");',
        "} else {",
        '  process.stderr.write("not ok beta\\n  regression\\n");',
        '  process.stderr.write("1 failed, 0 passed\\n");',
        "  process.exitCode = 1;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "scripts", "victim-helper.mjs"),
      'export const VALUE = "committed";\n',
    );
    writeManifest(root, {
      "scripts/sentry-alpha.test.mjs": { reporter: "count-line", floor: 1 },
      "scripts/sentry-beta.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "rewriting an imported helper must red the gate");
    assert(
      stdout.includes("victim-helper.mjs was REWRITTEN"),
      `should name the helper: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a relative import escaping the repository fails closed", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-a.test.mjs", 'import "../../outside.mjs";\n');
    writeManifest(root, {
      "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an escaping import must red the gate");
    assert(
      stderr.includes("resolve outside the repository"),
      `should say it cannot watch it: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("the success attestation states what ran and what only had its route checked", async () => {
  // Codex 3760861962. The footer claimed all N entries were "asserted from
  // their own output" while the exempt entry was never spawned — a false
  // statement in the operator-facing output of a required check.
  assertEqual(
    successAttestation(12, 1),
    "12 suites ran and were asserted from their own output; 1 entry was NOT run here — only the route to the job that does run it was verified.",
    "mixed run",
  );
  assertEqual(
    successAttestation(3, 0),
    "3 suites ran and were asserted from their own output.",
    "nothing exempt",
  );
  assertEqual(
    successAttestation(1, 1),
    "1 suite ran and was asserted from its own output; 1 entry was NOT run here — only the route to the job that does run it was verified.",
    "singular agreement",
  );
});

await test("red: a suite forging an exemption's route evidence is caught", async () => {
  const root = makeRoot();
  try {
    // The route is evidence about code this gate never runs. An earlier suite
    // restoring the import in the writable checkout made a throwing exempt
    // suite read as intact — gate exit 0 — while the production job would never
    // have run it.
    writeSuite(
      root,
      "sentry-aaa-forger.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./tf-stacks.test.mjs", import.meta.url)),',
        "  'import \"./sentry-provider-contract.test.mjs\";\\n');",
        'process.stdout.write("ok forger\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry-provider-contract.test.mjs",
      'throw new Error("provider contract suite is broken");\n',
    );
    writeFileSync(
      join(root, "scripts", "tf-stacks.test.mjs"),
      "// no import of the suite\n",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { "tf:test": "node scripts/tf-stacks.test.mjs" },
      }),
    );
    writeManifest(root, {
      "scripts/sentry-aaa-forger.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
      "scripts/sentry-provider-contract.test.mjs": {
        reporter: "exit-only",
        exempt: {
          runBy: "production-infra-contract",
          via: "pnpm tf:test",
          importer: "scripts/tf-stacks.test.mjs",
        },
      },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a forged route must red the gate");
    assert(
      stdout.includes("modified the evidence for it"),
      `should refuse the exemption: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite created mid-run is caught by re-enumeration", async () => {
  const root = makeRoot();
  try {
    // Set equality runs once, before any child; a digest sweep over KNOWN files
    // cannot see a file that did not exist when the baseline was taken.
    writeSuite(
      root,
      "sentry-aaa-spawner.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./sentry-zzz-new.test.mjs", import.meta.url)), "// smuggled\\n");',
        'process.stdout.write("ok spawner\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-aaa-spawner.test.mjs": {
        reporter: "count-line",
        floor: 1,
      },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a suite created mid-run must red the gate");
    assert(
      stdout.includes("changed while the gate was running"),
      `should report the enumeration change: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

summarize();
