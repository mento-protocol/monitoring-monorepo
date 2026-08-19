#!/usr/bin/env node
/**
 * The sentry-suite gate's INTEGRITY suite (issue #1779, ADR 0062).
 *
 * Split out of scripts/sentry/gate/sentry-suite-gate.test.mjs when that file crossed the
 * repo's 1,000-line hard cap, which the checker's own file-size pin now
 * enforces on it. The split is behaviour-neutral: no case was renamed or
 * rewritten, only moved.
 *
 * This half owns what the gate DERIVES and watches; the isolation sibling
 * (sentry-suite-gate-isolation.test.mjs, split off when this file hit the cap)
 * owns whether one suite can reach another's inputs:
 *
 *   - the watch set EQUALS the inputs the gate consults to decide, derived from
 *     the manifest rather than hand-listed, following V8's imports and the
 *     declared file and directory reads;
 *   - a declaration that is absent, phantom, escaping, or not a directory is
 *     rejected, and an undeclared read fails the suite that needed it;
 *   - a suite created mid-run is caught by re-enumeration;
 *   - an exemption's route evidence cannot be rewritten by an earlier suite;
 *   - fixture gates never write their tables into the real step summary.
 *
 * Named `sentry-*.test.mjs` on purpose, like its sibling: `findSentrySuites`
 * enumerates it, so the gate runs it and holds it to a floor like any other
 * suite. Dependency-free — only `node:` builtins and local sibling modules, an
 * invariant one of the cases below now derives and checks rather than asserting
 * from the file-naming convention.
 */

import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  digestDrift,
  digestFile,
  digestWatchSet,
  gateInputs,
  importClosure,
  successAttestation,
} from "./sentry-suite-gate.mjs";
import { staticImportsOf } from "../../lib/static-imports.mjs";

const { test, assert, assertEqual, summarize } = makeHarness();

/** This repository, for the cases that must hold of the committed tree. */
const REAL_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ── (a2) suite isolation: one child must not be able to reach another's inputs ─

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
    mkdirSync(join(root, "scripts", "sentry", "gate"), { recursive: true });
    writeFileSync(
      join(
        root,
        "scripts",
        "sentry",
        "gate",
        "sentry-provider-contract.test.mjs",
      ),
      "// exempt\n",
    );
    writeFileSync(
      join(root, "scripts", "tf-stacks.test.mjs"),
      'import "./sentry/gate/sentry-provider-contract.test.mjs";\n',
    );
    const manifest = {
      suites: {
        "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
        "scripts/sentry/gate/sentry-provider-contract.test.mjs": {
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
        "scripts/sentry/gate/sentry-provider-contract.test.mjs",
        "scripts/sentry/gate/sentry-suite-gate.mjs",
        "scripts/sentry/gate/sentry-suite-manifest.json",
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

await test("the watch set follows MULTILINE imports and ignores imports in string literals", async () => {
  // Codex 3761232904. The scanner was line-anchored to stop it counting
  // `import` inside a string literal — a real fix that created a false negative:
  // ordinary multiline imports stopped matching, so the implementation modules
  // of three committed suites dropped out of the derived watch set and an
  // earlier suite could rewrite a later suite's implementation, forge its pass,
  // and leave the final digest sweep green. Both columns are asserted here, in
  // one case, because fixing either one by regex broke the other.
  const root = makeRoot();
  try {
    writeSuite(
      root,
      "sentry-a.test.mjs",
      [
        "import {",
        "  implementation,",
        '} from "./implementation.mjs";',
        // The false positive the line anchor was added for: fixture source
        // embedded as a string must not become a watched dependency.
        "const fixture = 'import \"./not-a-real-file.mjs\";';",
        "void implementation;",
        "void fixture;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "scripts", "implementation.mjs"),
      "export const implementation = 1;\n",
    );
    const inputs = gateInputs(
      {
        suites: {
          "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
        },
      },
      root,
    );
    assert(
      inputs.includes("scripts/implementation.mjs"),
      `a multiline import must be watched: ${JSON.stringify(inputs)}`,
    );
    assert(
      !inputs.includes("scripts/not-a-real-file.mjs"),
      `an import inside a string literal must not be watched: ${JSON.stringify(inputs)}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("the watch set covers the gate's OWN imports, not just its entry file", async () => {
  // The gate's source decides how every result is judged, and most of that
  // source now lives in the modules it imports. Watching only the entry file
  // left them rewritable mid-run — the same hole as an unwatched suite helper,
  // one level up.
  const inputs = gateInputs(
    JSON.parse(
      readFileSync(
        join(REAL_ROOT, "scripts/sentry/gate/sentry-suite-manifest.json"),
        "utf8",
      ),
    ),
    REAL_ROOT,
  );
  for (const module of [
    "scripts/sentry/gate/sentry-suite-gate.mjs",
    "scripts/sentry/gate/sentry-suite-gate-integrity.mjs",
    "scripts/lib/static-imports.mjs",
    "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs",
  ]) {
    assert(
      inputs.includes(module),
      `${module} decides the verdict but is not watched: ${JSON.stringify(inputs)}`,
    );
  }
});

await test("everything the gate loads or spawns imports only node: builtins and siblings", async () => {
  // The `sentry-suites` job runs with NO `pnpm install` — that is what closes
  // the R1 postinstall window. A package specifier anywhere in the gate's load
  // closure breaks the job, and the closure now reaches beyond `sentry-*`: the
  // gate imports the checker's command grammar and the shared V8 parser. Derive
  // the closure and check it rather than trusting the file-naming convention.
  const manifest = JSON.parse(
    readFileSync(
      join(REAL_ROOT, "scripts/sentry/gate/sentry-suite-manifest.json"),
      "utf8",
    ),
  );
  const entries = ["scripts/sentry/gate/sentry-suite-gate.mjs"];
  for (const [suite, entry] of Object.entries(manifest.suites)) {
    // The exempt suite is never loaded here; it runs in another job, whose own
    // install is allowed to provide packages.
    if (!entry.exempt) entries.push(suite);
  }
  const loaded = [...entries, ...importClosure(entries, REAL_ROOT).local];
  const parsed = staticImportsOf(loaded.map((p) => join(REAL_ROOT, p)));
  const packageImports = [];
  for (const relative of loaded) {
    for (const specifier of parsed.get(join(REAL_ROOT, relative))?.specifiers ??
      []) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      packageImports.push(`${relative} -> ${specifier}`);
    }
  }
  assertEqual(
    JSON.stringify(packageImports),
    "[]",
    "a package import in the gate's load closure would fail the no-install job",
  );
  assert(
    loaded.length > 20,
    `the closure looks empty: ${loaded.length} modules`,
  );
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

await test("a suite rewriting another's imported helper changes nothing, even transiently", async () => {
  const root = makeRoot();
  try {
    // Codex 3760861940 then 3761572724. `alpha` rewrites the helper `beta`
    // imports AND restores the committed bytes before exiting — the transient
    // form, which left every digest matching its baseline and the gate at exit
    // 0. There is nothing to restore now: `alpha` rewrote its own copy, and
    // `beta` reads a helper `alpha` never had a path to.
    writeSuite(
      root,
      "sentry-alpha.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'const helper = fileURLToPath(new URL("./victim-helper.mjs", import.meta.url));',
        // The transient rewrite: forge, then put the committed bytes back, so a
        // before/after digest sees an unchanged file.
        "writeFileSync(helper, 'export const VALUE = \"forged\";\\n');",
        "writeFileSync(helper, 'export const VALUE = \"committed\";\\n');",
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
    assert(
      status !== 0,
      "beta fails against the committed helper, so the gate must red",
    );
    assert(
      !stdout.includes("ok beta"),
      `beta must not have seen the forged value: ${stdout}`,
    );
    assert(
      /sentry-beta\.test\.mjs \| FAIL/.test(stdout),
      `beta's real failure must be the reported result: ${stdout}`,
    );
    assert(
      !stdout.includes("TAMPERED"),
      `the checkout itself was never touched: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite reading a repository file it did not declare fails on the missing file", async () => {
  const root = makeRoot();
  try {
    // Codex 3761572727 named one such read (`sentry-mcp-broker.test.mjs` opens
    // `.github/workflows/sentry-triage-agent.yml`); running every suite from a
    // sparse snapshot found six across three suites. This is what keeps the
    // declaration honest — an undeclared read is not "undetectable", it is a
    // hard failure, because the file is simply not in the snapshot.
    writeFileSync(join(root, "policy.json"), '{"limit":1}\n');
    writeSuite(
      root,
      "sentry-reader.test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'const policy = JSON.parse(readFileSync(fileURLToPath(new URL("../policy.json", import.meta.url)), "utf8"));',
        'if (policy.limit !== 1) throw new Error("forged policy");',
        'process.stdout.write("ok reader\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeManifest(root, {
      "scripts/sentry-reader.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const undeclared = runGate(root);
    assert(
      undeclared.status !== 0,
      "an undeclared runtime read must red the gate",
    );
    assert(
      `${undeclared.stdout}${undeclared.stderr}`.includes("ENOENT"),
      `the suite should fail on the absent file: ${undeclared.stdout}`,
    );

    // Declared, it is copied in and the suite passes — so the declaration is
    // the whole difference, and a reviewer sees every non-module input.
    writeManifest(root, {
      "scripts/sentry-reader.test.mjs": {
        reporter: "count-line",
        floor: 1,
        reads: ["policy.json"],
      },
    });
    const declared = runGate(root);
    assertEqual(
      declared.status,
      0,
      `declaring the read should make it pass: ${declared.stdout}${declared.stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("a declared directory is copied whole, so an enumerating suite sees the checkout", async () => {
  // Codex 3761902959, and the limit of the round-11 argument. Sparseness is
  // self-enforcing for a suite that OPENS a file — absent, so it dies. A suite
  // that ENUMERATES a sparsely populated directory does not die; it passes
  // having checked almost nothing. `sentry-triage-requeue.test.mjs` walks every
  // non-test `scripts/*.mjs` to prove one function has a single call site, and
  // saw 25 of 92 — so a forbidden call in any of the other 67 was invisible.
  const manifest = JSON.parse(
    readFileSync(
      join(REAL_ROOT, "scripts/sentry/gate/sentry-suite-manifest.json"),
      "utf8",
    ),
  );
  // Both suites walk scripts/ RECURSIVELY (ADR 0064 made it a tree), so the
  // completeness this asserts is over the whole tree. Comparing only the flat
  // top level would have gone on passing while each phase of the reorganization
  // moved modules out of the compared set.
  const isTarget = (f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs");
  const onDisk = readdirSync(join(REAL_ROOT, "scripts"), {
    recursive: true,
  }).filter(isTarget);
  for (const suite of [
    "scripts/sentry/triage/sentry-triage-requeue.test.mjs",
    "scripts/sentry/triage/sentry-triage-brief.test.mjs",
  ]) {
    const entry = manifest.suites[suite];
    assert(
      (entry.readsDirs ?? []).includes("scripts"),
      `${suite} enumerates scripts/, so it must declare it in readsDirs`,
    );
    const inputs = gateInputs(manifest, REAL_ROOT);
    const visible = inputs
      .filter((p) => p.startsWith("scripts/"))
      .map((p) => p.slice("scripts/".length))
      .filter(isTarget);
    // Compare the PATHS, not the counts. Equal totals prove nothing on their
    // own: one stale entry still listed in the snapshot offsets one nested
    // module missing from it, and the subset this exists to forbid passes with
    // the arithmetic intact. Name both directions so a failure says which file.
    const visibleSet = new Set(visible);
    const onDiskSet = new Set(onDisk);
    const missing = onDisk.filter((p) => !visibleSet.has(p)).sort();
    const extra = visible.filter((p) => !onDiskSet.has(p)).sort();
    assert(
      missing.length === 0 && extra.length === 0,
      `${suite} must see every non-test scripts/**/*.mjs, not a subset` +
        (missing.length > 0
          ? `; on disk but not visible: ${missing.join(", ")}`
          : "") +
        (extra.length > 0
          ? `; visible but not on disk: ${extra.join(", ")}`
          : ""),
    );
  }
});

await test("red: a readsDirs entry that is not a directory is rejected", async () => {
  const root = makeRoot();
  try {
    // Declaring a FILE here would copy it without its siblings and leave the
    // enumeration sparse — the very thing the field exists to remove.
    writeSuite(root, "sentry-a.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-a.test.mjs": {
        reporter: "count-line",
        floor: 1,
        readsDirs: ["package.json"],
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "a non-directory readsDirs entry must red the gate");
    assert(
      stderr.includes("not a directory"),
      `should say what readsDirs means: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a declared read that does not exist is rejected at load", async () => {
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-a.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-a.test.mjs": {
        reporter: "count-line",
        floor: 1,
        reads: ["docs/not-here.md"],
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "a phantom declared read must red the gate");
    assert(
      stderr.includes("but no such file exists"),
      `should name the missing declaration: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a declared read cannot climb out of the repository", async () => {
  const root = makeRoot();
  try {
    // Snapshots are built by joining these onto a temp directory, so a path
    // that escapes would write outside it.
    writeSuite(root, "sentry-a.test.mjs", countLineSuite(1));
    writeManifest(root, {
      "scripts/sentry-a.test.mjs": {
        reporter: "count-line",
        floor: 1,
        reads: ["../../etc/hosts"],
      },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an escaping declared read must red the gate");
    assert(
      stderr.includes("not inside the repository"),
      `should refuse the path: ${stderr}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a watched file V8 cannot parse fails closed rather than reading as import-free", async () => {
  // Asking V8 means a file it refuses is a file whose dependencies are unknown.
  // Treating that as "imports nothing" is how a dependency silently leaves the
  // watch set, which is the whole class of bug this layer exists to close.
  const root = makeRoot();
  try {
    writeSuite(root, "sentry-a.test.mjs", 'import "./broken.mjs";\n');
    writeFileSync(join(root, "scripts", "broken.mjs"), "import { from;\n");
    writeManifest(root, {
      "scripts/sentry-a.test.mjs": { reporter: "count-line", floor: 1 },
    });
    const { status, stderr } = runGate(root);
    assert(status !== 0, "an unparsable dependency must red the gate");
    assert(
      stderr.includes("could not be parsed for its static imports"),
      `should name the unparsable file: ${stderr}`,
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

await test("red: a suite forging an exemption's route evidence cannot reach the evidence", async () => {
  const root = makeRoot();
  try {
    // The route is evidence about code this gate never runs. An earlier suite
    // restoring the import in the writable checkout made a throwing exempt
    // suite read as intact — gate exit 0 — while the production job would never
    // have run it. The route is now read from the exempt entry's own snapshot,
    // taken before the forger ran, so the forgery lands nowhere that is read.
    writeSuite(
      root,
      "sentry-aaa-forger.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'writeFileSync(fileURLToPath(new URL("./tf-stacks.test.mjs", import.meta.url)),',
        "  'import \"./sentry/gate/sentry-provider-contract.test.mjs\";\\n');",
        'process.stdout.write("ok forger\\n");',
        'process.stdout.write("1 passed\\n");',
        "",
      ].join("\n"),
    );
    writeSuite(
      root,
      "sentry/gate/sentry-provider-contract.test.mjs",
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
      "scripts/sentry/gate/sentry-provider-contract.test.mjs": {
        reporter: "exit-only",
        exempt: {
          runBy: "production-infra-contract",
          via: "pnpm tf:test",
          importer: "scripts/tf-stacks.test.mjs",
        },
      },
    });
    const { status, stdout } = runGate(root);
    assert(status !== 0, "a dead route must red the gate");
    assert(
      stdout.includes("ROUTE-BROKEN") &&
        stdout.includes("has no static import of"),
      `the route must still read as dead: ${stdout}`,
    );
  } finally {
    cleanup(root);
  }
});

await test("red: a suite created mid-run is caught by re-enumeration", async () => {
  const root = makeRoot();
  try {
    // Set equality runs once, before any child; a digest sweep over KNOWN files
    // cannot see a file that did not exist when the baseline was taken. The
    // spawner writes to the CHECKOUT by absolute path — the one surface a child
    // can still reach, standing in for a suite that reads GITHUB_WORKSPACE.
    writeSuite(
      root,
      "sentry-aaa-spawner.test.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(join(root, "scripts", "sentry-zzz-new.test.mjs"))}, "// smuggled\\n");`,
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
