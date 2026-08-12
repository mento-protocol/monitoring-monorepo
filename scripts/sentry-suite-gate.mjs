#!/usr/bin/env node
/**
 * Self-run Sentry-suite gate (issue #1779, ADR 0062).
 *
 * The #1754 checker proves CI *would* run the Sentry suites. It cannot prove
 * they *did* anything: a suite that exits 0 for an environment reason, or one
 * neutered by an injected `NODE_OPTIONS=--import=…process.exit(0)`, satisfies
 * every static assertion. This gate runs the suites itself and proves, from
 * their own output, that each asserted:
 *
 *   1. `findSentrySuites()` reconciles against sentry-suite-manifest.json by
 *      exact set equality, in both directions, failing closed on any add,
 *      remove, or rename and printing the JSON patch to apply.
 *   2. It refuses to start if NODE_OPTIONS or NODE_PATH is set in its own env —
 *      the tamper vector the per-child `env -u` latch below defends against, so
 *      losing the latch or setting the var on the gate itself is caught here.
 *   3. Each non-exempt suite is spawned under
 *      `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node <suite>`, from its OWN
 *      immutable snapshot of the derived input set, and must satisfy ALL of:
 *      child exit 0, parsed `fail == 0`, parsed `pass >= floor`, and
 *      `pass == the number of per-case lines the suite actually emitted`
 *      (`^ok ` for the homegrown count-line harness, `^✔ ` for node:test). Any
 *      parse failure or missing suite fails closed. Every snapshot is taken
 *      before the first child starts, so no suite can reach another's inputs —
 *      the guarantee digests could only approximate, since a rewrite that
 *      restored the original bytes before the final sweep was invisible to
 *      them. A suite's non-module reads are declared in the manifest and land
 *      in its snapshot; an undeclared one is simply absent, so the suite fails.
 *   4. Each exempt suite's route is re-verified: its documented importer still
 *      statically imports it (V8's module requests, so an unreached
 *      `import()` proves nothing) and the exact package.json alias the owning
 *      job runs is nothing but `node <importer>`. The exempt suite runs in
 *      another job (production-infra-contract via `pnpm tf:test`), never here.
 *
 * Dependency-free by construction: this file and everything it loads or spawns
 * import only `node:` builtins and repo-local siblings, so the CI
 * `sentry-suites` job runs with no `pnpm install` and thus no PR-authored
 * pre-suite code (postinstall) — the R1 window the ADR closes. That is not left
 * to convention: `sentry-suite-gate-integrity.test.mjs` derives the load closure
 * and fails on any package specifier in it.
 *
 * Test/fixture hooks (never set in CI):
 *   SENTRY_SUITE_GATE_ROOT — repo root override; the gate reads
 *     `<root>/scripts/*` and `<root>/scripts/sentry-suite-manifest.json`.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The integrity layer — "is this run trustworthy as a whole" — lives next door
// so both files stay under the repo's line cap. Re-exported because the gate is
// the public entry point its suites import from.
import {
  digestDrift,
  digestFile,
  digestWatchSet,
  gateInputs,
  importClosure,
  localImportClosure,
  MANIFEST_LABEL,
  snapshotDigest,
  snapshotDrift,
  snapshotInputs,
} from "./sentry-suite-gate-integrity.mjs";
// V8's own dependency list, shared with the CI-coverage checker so there is one
// implementation of "what does this module import" rather than two that drift.
import { staticImports } from "./static-imports.mjs";
// The checker's shell grammar, shared for the same reason: it already knows
// which package-script bodies can mask a non-zero exit.
import { commandRunsOnly } from "./check-sentry-suites-in-ci-core-commands.mjs";
// The manifest schema — "is this a legal description of a run" — lives next
// door for the same line-cap reason as the integrity layer. Re-exported so the
// gate stays the one entry point its suites import from.
import { GateError, loadManifest } from "./sentry-suite-gate-manifest.mjs";

export {
  digestDrift,
  digestFile,
  digestWatchSet,
  gateInputs,
  importClosure,
  loadManifest,
  localImportClosure,
  snapshotDigest,
  snapshotDrift,
  snapshotInputs,
  staticImports,
};

const ROOT = process.env.SENTRY_SUITE_GATE_ROOT
  ? realpathSync(process.env.SENTRY_SUITE_GATE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS_DIR = join(ROOT, "scripts");
const MANIFEST_PATH = join(SCRIPTS_DIR, "sentry-suite-manifest.json");

/** Node flags that force a deterministic node:test spec report regardless of TTY or minor version. */
const NODE_TEST_REPORTER_ARGS = [
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
];

/**
 * Every `sentry-*.test.mjs` under `dir`, at any depth, as a repo-relative path
 * (`scripts/sentry-x.test.mjs`). A dependency-free port of the checker's
 * symlink-following enumerator (check-sentry-suites-in-ci-probes.mjs): a Dirent
 * is an `lstat`, so a directory symlink reports `isDirectory() === false` and
 * would silently drop a suite behind it; resolve symlinks with `statSync` and
 * walk them, and fail closed on a cycle via a resolved-ancestor set. A broken
 * symlink throws here on purpose — an unresolvable entry must fail enumeration,
 * not vanish.
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {Set<string>} ancestors
 * @returns {string[]}
 */
export function findSentrySuites(
  dir,
  prefix = "scripts",
  ancestors = new Set(),
) {
  const realDir = realpathSync(dir);
  if (ancestors.has(realDir)) {
    throw new GateError(
      `symlink cycle under scripts/ at ${prefix} — resolve it; suite enumeration cannot walk a cycle`,
    );
  }
  const nextAncestors = new Set(ancestors).add(realDir);
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    const isDirectory = entry.isSymbolicLink()
      ? statSync(full).isDirectory()
      : entry.isDirectory();
    if (isDirectory) {
      found.push(...findSentrySuites(full, relative, nextAncestors));
    } else if (
      entry.name.startsWith("sentry-") &&
      entry.name.endsWith(".test.mjs")
    ) {
      found.push(relative);
    }
  }
  return found.sort();
}

/**
 * Compare enumerated suites against manifest keys by exact set equality.
 *
 * @param {string[]} found
 * @param {string[]} manifestKeys
 * @returns {{ equal: boolean, onDiskNotInManifest: string[], inManifestNotOnDisk: string[] }}
 */
export function reconcile(found, manifestKeys) {
  const foundSet = new Set(found);
  const manifestSet = new Set(manifestKeys);
  const onDiskNotInManifest = found.filter((f) => !manifestSet.has(f));
  const inManifestNotOnDisk = manifestKeys.filter((k) => !foundSet.has(k));
  return {
    equal: onDiskNotInManifest.length === 0 && inManifestNotOnDisk.length === 0,
    onDiskNotInManifest,
    inManifestNotOnDisk,
  };
}

/**
 * Parse the homegrown count-line harness output. Passes print `ok <name>` to
 * stdout. Two summary dialects exist across the suites and both are handled:
 *   - triage/archive/brief/…: `<n> passed` (success) or
 *     `<m> failed, <n> passed` (failure);
 *   - autofix-{select,finalize}: `<n> passed, <m> failed` (always).
 * Every pattern is anchored to a full line so prose containing "51 failed"
 * cannot be mistaken for the summary. The `$`-anchors make the three mutually
 * exclusive, so order only decides which throws.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {{ pass: number, fail: number, caseLines: number }}
 */
export function parseCountLine(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const caseLines = (stdout.match(/^ok /gm) || []).length;
  // Counted across BOTH streams: the harness writes `not ok` to stderr, but a
  // suite that prints one to stdout is exactly the shape being defended against.
  // One line per failure, so this reconciles exactly against the summary.
  const failLines = (combined.match(/^not ok /gm) || []).length;
  const passFail = combined.match(/^(\d+) passed, (\d+) failed$/m);
  if (passFail) {
    return {
      pass: Number(passFail[1]),
      fail: Number(passFail[2]),
      caseLines,
      failLines,
    };
  }
  const failPass = combined.match(/^(\d+) failed, (\d+) passed$/m);
  if (failPass) {
    return {
      pass: Number(failPass[2]),
      fail: Number(failPass[1]),
      caseLines,
      failLines,
    };
  }
  const passOnly = combined.match(/^(\d+) passed$/m);
  if (passOnly) {
    return { pass: Number(passOnly[1]), fail: 0, caseLines, failLines };
  }
  throw new GateError(
    "count-line output has no `<n> passed`, `<m> failed, <n> passed`, or `<n> passed, <m> failed` summary line",
  );
}

/**
 * Parse node:test spec-reporter output. Passes print `✔ <name>`; the summary
 * carries `ℹ pass <n>` and `ℹ fail <n>`.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {{ pass: number, fail: number, caseLines: number }}
 */
export function parseNodeTest(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const caseLines = (combined.match(/^✔ /gm) || []).length;
  // `failLines` here is a PRESENCE signal, not a count that reconciles against
  // the summary: the spec reporter prints each failure inline AND repeats it
  // under a `✖ failing tests:` header, so one real failure emits three `✖`
  // lines (measured). What is exact is the zero case — a run reporting
  // `ℹ fail 0` emits no `✖` line at all — so `judgeSuite` requires that
  // direction rather than an equality the format cannot support.
  const failLines = (combined.match(/^✖ /gm) || []).length;
  const passMatch = combined.match(/^ℹ pass (\d+)$/m);
  const failMatch = combined.match(/^ℹ fail (\d+)$/m);
  if (!passMatch || !failMatch) {
    throw new GateError(
      "node:test output has no `ℹ pass <n>` / `ℹ fail <n>` summary lines",
    );
  }
  return {
    pass: Number(passMatch[1]),
    fail: Number(failMatch[1]),
    caseLines,
    failLines,
    exactFailLines: false,
  };
}

/**
 * Spawn one suite under the `env -u` latch and parse its output. Exported so
 * the gate's own suite can prove the latch strips an injected NODE_OPTIONS.
 *
 * @param {string} suite repo-relative path
 * @param {{ reporter: string, nodeArgs?: string[] }} entry
 * @param {{ root?: string }} [opts]
 * @returns {{ suite: string, exit: number|null, signal: string|null, pass?: number, fail?: number, caseLines?: number, parseError?: string, stdout: string, stderr: string }}
 */
export function runSuite(suite, entry, opts = {}) {
  const root = opts.root || ROOT;
  const reporterArgs =
    entry.reporter === "node-test" ? NODE_TEST_REPORTER_ARGS : [];
  const args = [
    "-u",
    "NODE_OPTIONS",
    "-u",
    "NODE_PATH",
    "node",
    ...(entry.nodeArgs || []),
    ...reporterArgs,
    suite,
  ];
  const child = spawnSync("/usr/bin/env", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
  });
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const result = {
    suite,
    exit: child.status,
    signal: child.signal,
    stdout,
    stderr,
  };
  if (child.error) {
    result.parseError = `spawn failed: ${child.error.message}`;
    return result;
  }
  try {
    const parsed =
      entry.reporter === "node-test"
        ? parseNodeTest(stdout, stderr)
        : parseCountLine(stdout, stderr);
    Object.assign(result, parsed);
  } catch (err) {
    result.parseError = err.message;
  }
  return result;
}

/**
 * Judge a spawned suite against its manifest entry. Returns the list of reasons
 * it failed; empty means it passed.
 *
 * @param {object} result from runSuite
 * @param {{ floor: number }} entry
 * @returns {string[]}
 */
export function judgeSuite(result, entry) {
  const reasons = [];
  if (result.signal) reasons.push(`killed by signal ${result.signal}`);
  if (result.exit !== 0) reasons.push(`exit ${result.exit} (expected 0)`);
  if (result.parseError) {
    reasons.push(result.parseError);
    return reasons; // no counts to judge
  }
  if (result.fail !== 0) reasons.push(`${result.fail} test(s) reported failed`);

  // Reconcile the FAILURE side against emitted lines, the mirror of the
  // `pass == caseLines` check below. Without it the summary was trusted alone
  // for failures, so a suite printing `ok before`, `1 passed`, then
  // `not ok failure after summary` was accepted at pass=1/lines=1 — the gate
  // reproducing the very "summary does not describe what ran" defect it exists
  // to catch. Any emitted failure line rejects the suite whatever the summary
  // claims; a zero-failure summary must come with zero failure lines.
  if (result.failLines > 0) {
    reasons.push(
      `${result.failLines} failure line(s) emitted while the summary reported fail=${result.fail} — ` +
        "a failure printed after the summary still means the suite failed",
    );
  }
  // Where one emitted line means exactly one failure (the count-line harness),
  // require the two numbers to agree outright. The node:test spec reporter
  // repeats failures in a trailing block, so it opts out via `exactFailLines`
  // and is covered by the zero-case rule above.
  if (result.exactFailLines !== false && result.failLines !== result.fail) {
    reasons.push(
      `the summary reported fail=${result.fail} but ${result.failLines} failure line(s) were emitted`,
    );
  }

  if (result.pass < entry.floor) {
    reasons.push(
      `pass ${result.pass} < floor ${entry.floor} — if tests were intentionally deleted, lower the floor for ${result.suite} in ${MANIFEST_LABEL} to ${result.pass}; otherwise a test stopped running and that is the bug.`,
    );
  }
  if (result.pass !== result.caseLines) {
    reasons.push(
      `pass ${result.pass} != ${result.caseLines} per-case line(s) emitted (hollow or misordered summary)`,
    );
  }
  return reasons;
}

/**
 * Re-verify an exempt suite's route without running it: the documented importer
 * must still statically import the suite, and package.json must still route to
 * that importer.
 *
 * @param {string} suite repo-relative path of the exempt suite
 * @param {{ importer: string, runBy?: string, via?: string }} exempt
 * @param {string} root
 * @returns {string[]} reasons the route is broken; empty means intact
 */
export function verifyExemptRoute(suite, exempt, root) {
  const reasons = [];
  // V8's dependency list for the importer, not a scan of its text. A regex was
  // satisfied first by a comment naming the path, then by
  // `if (false) import("./sentry-provider-contract.test.mjs")` — an import
  // expression that never runs, recorded as proof that the module loads the
  // suite (Codex 3761232894). A module request is the only thing that makes
  // `pnpm tf:test` actually execute the exempt suite, so ask for module
  // requests.
  let specifiers;
  try {
    specifiers = staticImports(join(root, exempt.importer));
  } catch (err) {
    reasons.push(
      `importer ${exempt.importer} could not be parsed for its static imports: ${err.message}`,
    );
    return reasons;
  }
  const base = suite.slice(suite.lastIndexOf("/") + 1);
  if (!specifiers.includes(`./${base}`)) {
    reasons.push(
      `importer ${exempt.importer} has no static import of ./${base} (its imports are ` +
        `${JSON.stringify(specifiers)}); the exemption is dead`,
    );
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // The manifest names the exact command the owning job runs, so validate
    // THAT alias rather than "some script somewhere runs the importer". Scanning
    // every script accepted an unused `decoy` while the named `tf:test` had been
    // turned into `echo skipped` — the owning job would have run the no-op and
    // the suite would never have executed anywhere (measured: gate exit 0 on a
    // provider suite that throws on load).
    const via = String(exempt.via ?? "");
    const alias = via.startsWith("pnpm ")
      ? via.slice("pnpm ".length).trim()
      : "";
    if (alias === "") {
      reasons.push(
        `the exempt route's \`via\` is ${JSON.stringify(via)}, which is not a \`pnpm <script>\` ` +
          "invocation; the route must name the exact command the owning job runs",
      );
    } else {
      const command = pkg.scripts?.[alias];
      if (typeof command !== "string") {
        reasons.push(
          `package.json has no \`${alias}\` script, so \`${via}\` — the command ` +
            `\`${exempt.runBy || "the owning job"}\` runs — cannot run ${exempt.importer}`,
        );
      } else if (!commandRunsOnly(command, [["node", exempt.importer]])) {
        // Parsed as shell, not matched: the alias must be ONE simple command
        // and that command must be exactly `node <importer>`. A regex anchored
        // on `&&`/`||`/`;` accepted both `true || node scripts/tf-stacks.test.mjs`
        // (the importer never runs) and `node scripts/tf-stacks.test.mjs || true`
        // (its failures are swallowed), and would have kept accepting the next
        // form nobody enumerated (Codex 3761232900). A package script is handed
        // to a shell WITHOUT `-e`, so a second line decides the alias's exit
        // status too; `commandRunsOnly` rejects every one of these because it
        // allowlists bare words rather than blacklisting operators.
        reasons.push(
          `the \`${alias}\` script is ${JSON.stringify(command)}, which is not exactly ` +
            `\`node ${exempt.importer}\` and nothing else; \`${via}\` is the ONLY command ` +
            `\`${exempt.runBy || "the owning job"}\` runs, so any shell syntax around it can ` +
            "stop the importer running or swallow its failures",
        );
      }
    }
  } catch (err) {
    reasons.push(`package.json unreadable for route check: ${err.message}`);
  }
  return reasons;
}

/**
 * The success line, stating separately what was RUN and what was only
 * route-verified. Exported so its wording is testable.
 *
 * @param {number} ran suites spawned and asserted from their own output
 * @param {number} exempted entries not spawned here, whose route was checked
 */
export function successAttestation(ran, exempted) {
  const spawned = `${ran} suite${ran === 1 ? "" : "s"} ran and ${
    ran === 1 ? "was" : "were"
  } asserted from ${ran === 1 ? "its" : "their"} own output`;
  if (exempted === 0) return `${spawned}.`;
  return (
    `${spawned}; ${exempted} entr${exempted === 1 ? "y was" : "ies were"} NOT run here — ` +
    `only the route to the job that does run ${exempted === 1 ? "it" : "them"} was verified.`
  );
}

/** Emit `text` to stdout and, when running under Actions, to the step summary. */
function report(text) {
  process.stdout.write(text);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, text);
    } catch {
      // A step-summary write failure must never fail the gate.
    }
  }
}

export function main() {
  // (2) Refuse to start under a tamper env. env -u strips these per child, but
  // seeing them on the gate itself means the latch was removed or the gate is
  // being driven under the very injection it defends against.
  for (const name of ["NODE_OPTIONS", "NODE_PATH"]) {
    if (process.env[name] != null && process.env[name] !== "") {
      process.stderr.write(
        `sentry-suite-gate: refusing to start — ${name} is set (${JSON.stringify(
          process.env[name],
        )}). This gate must run under a clean environment; the CI step invokes it as \`env -u NODE_OPTIONS node …\`.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  let manifest;
  let found;
  try {
    manifest = loadManifest(MANIFEST_PATH, ROOT);
    found = findSentrySuites(SCRIPTS_DIR);
  } catch (err) {
    process.stderr.write(`sentry-suite-gate: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const manifestKeys = Object.keys(manifest.suites).sort();
  const { equal, onDiskNotInManifest, inManifestNotOnDisk } = reconcile(
    found,
    manifestKeys,
  );
  if (!equal) {
    const patch = {};
    if (onDiskNotInManifest.length) {
      patch.add = Object.fromEntries(
        onDiskNotInManifest.map((s) => [
          s,
          { reporter: "count-line", floor: "<re-measure>" },
        ]),
      );
    }
    if (inManifestNotOnDisk.length) patch.remove = inManifestNotOnDisk;

    // A single add paired with a single remove is almost always a rename or a
    // suite split; call it out so the fix is obvious.
    const lines = [
      `sentry-suite-gate: the Sentry suite set changed — update ${MANIFEST_LABEL} to match the scripts/sentry-*.test.mjs files on disk.`,
    ];
    if (onDiskNotInManifest.length === 1 && inManifestNotOnDisk.length === 1) {
      lines.push(
        `  looks like a rename: ${inManifestNotOnDisk[0]} → ${onDiskNotInManifest[0]}. Rename that key in ${MANIFEST_LABEL} (and re-measure its floor if the file changed).`,
      );
    }
    for (const s of onDiskNotInManifest) {
      lines.push(
        `  add a "${s}" entry to ${MANIFEST_LABEL} — a suite file exists with no manifest entry (new suite, or a split you must list too). Measure its pass count with \`node ${s}\` and use that as "floor".`,
      );
    }
    for (const s of inManifestNotOnDisk) {
      lines.push(
        `  remove the "${s}" entry from ${MANIFEST_LABEL} — the manifest lists it but no such file is on disk (deleted or renamed).`,
      );
    }
    lines.push(
      `Apply this patch to ${MANIFEST_LABEL}:`,
      JSON.stringify(patch, null, 2),
      "",
    );
    process.stderr.write(lines.join("\n"));
    process.exitCode = 1;
    return;
  }

  // (3)(4) Execute non-exempt suites; re-verify exempt routes.
  //
  // Each entry gets its OWN copy of the derived input set, and every copy is
  // taken before the FIRST child starts. That is the whole guarantee: a child
  // cannot reach another child's inputs, so there is no interference to detect
  // — not a persistent rewrite, and not a transient one that restores the
  // original bytes before the sweep looks (which digests could never catch).
  // Taking the copies lazily would reopen it: an earlier suite could poison the
  // shared checkout and a later snapshot would copy the poison faithfully.
  let inputs;
  let snapshotBase;
  const snapshots = new Map();
  const snapshotBaselines = new Map();
  try {
    inputs = gateInputs(manifest, ROOT);
    snapshotBase = mkdtempSync(join(tmpdir(), "sentry-suite-gate-"));
    for (const [suite, entry] of Object.entries(manifest.suites)) {
      const files = [...inputs, ...(entry.reads ?? [])];
      // A RANDOM name, not one derived from the suite. Deterministic sibling
      // names under a shared base were addressable: each child gets its
      // snapshot as `cwd`, so `dirname(process.cwd())` plus the victim's
      // sanitised manifest path reached the victim's inputs, and a suite that
      // throws against committed code reported `ok` at exit 0 (Codex
      // 3761902954).
      const dest = mkdtempSync(join(snapshotBase, "s-"));
      snapshots.set(
        suite,
        snapshotInputs(files, ROOT, dest, entry.readsDirs ?? []),
      );
      snapshotBaselines.set(suite, snapshotDigest(dest));
    }
    // Traverse but do not list. A child can still enter its OWN snapshot (its
    // cwd), and the gate can still reach every one, but `readdir` on the base
    // fails — so the random names cannot be enumerated either. Guessing and
    // listing are the only two ways to address a sibling, and this closes the
    // second; the pre-spawn verification below is what makes the guarantee not
    // depend on either.
    chmodSync(snapshotBase, 0o111);
  } catch (err) {
    process.stderr.write(`sentry-suite-gate: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Still taken, and still swept at the end — but as a tamper ALARM on the
  // shared checkout rather than as the guarantee. Nothing this run decides is
  // read from the checkout after this point, so a child writing there cannot
  // change a verdict; it is still something an operator must see, because a
  // suite that writes to the repository is doing something no suite should.
  const baseline = digestWatchSet(manifest, ROOT, inputs);

  const rows = [];
  let failures = 0;
  // Counted separately so the success line can state what was actually done.
  let ran = 0;
  let exempted = 0;
  for (const suite of manifestKeys) {
    const entry = manifest.suites[suite];
    if (entry.exempt) {
      // Read from the snapshot, like every suite: the route is evidence about
      // code this gate never runs, and the snapshot was taken before any child
      // could touch the importer or package.json. The digest pre-check this
      // replaces could only catch a rewrite that persisted.
      const routeTamper = snapshotDrift(
        snapshotBaselines.get(suite),
        snapshots.get(suite),
      );
      if (routeTamper.length > 0) {
        rows.push({
          suite,
          status: "TAMPERED",
          detail: `${routeTamper.join("; ")} — refusing to accept the exemption; an earlier suite reached its route evidence`,
        });
        failures += 1;
        continue;
      }
      const reasons = verifyExemptRoute(
        suite,
        entry.exempt,
        snapshots.get(suite),
      );
      rows.push({
        suite,
        status: reasons.length ? "ROUTE-BROKEN" : "exempt",
        detail:
          reasons.join("; ") ||
          `NOT run here; route to ${entry.exempt.runBy || "another job"} verified`,
      });
      if (reasons.length) failures += 1;
      else exempted += 1;
      continue;
    }
    // Verify THIS suite's snapshot at the moment it runs. Every earlier child
    // has already exited, so a write into these inputs is on disk now and
    // cannot be taken back — unlike a rewrite of the shared checkout, which the
    // old post-run sweep could miss if it was undone.
    const snapshotTamper = snapshotDrift(
      snapshotBaselines.get(suite),
      snapshots.get(suite),
    );
    if (snapshotTamper.length > 0) {
      rows.push({
        suite,
        status: "TAMPERED",
        detail: `${snapshotTamper.join("; ")} — refusing to run it; an earlier suite in this gate run reached this suite's inputs`,
      });
      failures += 1;
      continue;
    }
    // From its own snapshot, so the result is this suite's by construction.
    const result = runSuite(suite, entry, { root: snapshots.get(suite) });
    const reasons = judgeSuite(result, entry);
    rows.push({
      suite,
      status: reasons.length ? "FAIL" : "ok",
      detail: reasons.length
        ? reasons.join("; ")
        : `pass=${result.pass} floor=${entry.floor} lines=${result.caseLines}`,
    });
    if (reasons.length === 0) ran += 1;
    if (reasons.length) {
      failures += 1;
      // A summary row names WHICH suite broke but never why, which leaves a
      // contributor re-running the suite by hand to find out. Echo the failing
      // suite's own diagnostics — the `not ok` / `✖` lines and any stack — so
      // the gate's output is self-contained.
      // A suite that DIES rather than reporting failures prints its error at
      // column 0, which the indented-`Error` pattern missed — so a suite killed
      // by an undeclared runtime read showed only "no summary line" and the
      // contributor had no way to see the `ENOENT` that explains it. That
      // legibility is load-bearing now that a missing declared read is how the
      // manifest's `reads` list stays complete.
      const detail = `${result.stdout}\n${result.stderr}`
        .split("\n")
        .filter((line) =>
          /^(not ok |✖|\s*(Error|AssertionError|TypeError|ReferenceError|SyntaxError)\b)/.test(
            line,
          ),
        )
        .slice(0, 20);
      if (detail.length > 0) {
        process.stderr.write(
          `\n--- ${suite} reported:\n${detail.join("\n")}\n`,
        );
      }
    }
  }

  // Enumeration is a decision input too: set equality was computed once, before
  // any child ran, so a suite CREATED mid-run in the shared checkout would never
  // be reconciled and a digest sweep over known files cannot see it.
  try {
    const after = findSentrySuites(SCRIPTS_DIR);
    const { equal, onDiskNotInManifest, inManifestNotOnDisk } = reconcile(
      after,
      manifestKeys,
    );
    if (!equal) {
      rows.push({
        suite: MANIFEST_LABEL,
        status: "TAMPERED",
        detail:
          `the set of scripts/sentry-*.test.mjs changed while the gate was running ` +
          `(appeared: ${JSON.stringify(onDiskNotInManifest)}, vanished: ${JSON.stringify(inManifestNotOnDisk)}) — ` +
          "a suite added or removed mid-run was never reconciled against the manifest",
      });
      failures += 1;
    }
  } catch (err) {
    rows.push({
      suite: MANIFEST_LABEL,
      status: "TAMPERED",
      detail: `re-enumerating the suites after the run failed: ${err.message}`,
    });
    failures += 1;
  }

  // The tamper alarm on the shared checkout. No verdict above depended on it —
  // every child read its own snapshot — but a suite that wrote to the
  // repository did something no suite should, and the next run would inherit
  // it, so the gate reds and names the file.
  const finalDrift = digestDrift(baseline, ROOT);
  for (const change of finalDrift) {
    rows.push({
      suite: change.split(" ")[0],
      status: "TAMPERED",
      detail: `${change} — a suite wrote to the shared checkout; this run's results came from per-suite snapshots, but the checkout is no longer the committed tree`,
    });
    failures += 1;
  }

  chmodSync(snapshotBase, 0o700);
  rmSync(snapshotBase, { recursive: true, force: true });

  const table = [
    "",
    "## Sentry-suite gate",
    "",
    "| suite | status | detail |",
    "| ----- | ------ | ------ |",
    ...rows.map((r) => `| ${r.suite} | ${r.status} | ${r.detail} |`),
    "",
    // The attestation must be true of a normal run without the reader knowing
    // what "exempt" means. It previously said all N entries were "asserted from
    // their own output" while the exempt entry was never spawned at all — a
    // false statement in the operator-facing output of a required check, and
    // one a reviewer took at face value.
    failures === 0
      ? successAttestation(ran, exempted)
      : `${failures} suite(s) failed the gate.`,
    "",
  ].join("\n");
  report(table);

  process.exitCode = failures === 0 ? 0 : 1;
}

// Run only when invoked directly, so the test suite can import the helpers.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
