#!/usr/bin/env node
/**
 * Self-run Sentry-suite gate (issue #1779, ADR 0059).
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
 *      `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node <suite>` and must satisfy
 *      ALL of: child exit 0, parsed `fail == 0`, parsed `pass >= floor`, and
 *      `pass == the number of per-case lines the suite actually emitted`
 *      (`^ok ` for the homegrown count-line harness, `^✔ ` for node:test). Any
 *      parse failure or missing suite fails closed.
 *   4. Each exempt suite's route is re-verified: its documented importer still
 *      statically imports it and package.json still routes there. The exempt
 *      suite runs in another job (production-infra-contract via `pnpm tf:test`),
 *      never here.
 *
 * Dependency-free by construction: it imports only `node:` builtins, so the CI
 * `sentry-suites` job runs it with no `pnpm install` and thus no PR-authored
 * pre-suite code (postinstall) — the R1 window the ADR closes. Every
 * `scripts/sentry-*.mjs` it spawns likewise imports only `node:` builtins.
 *
 * Test/fixture hooks (never set in CI):
 *   SENTRY_SUITE_GATE_ROOT — repo root override; the gate reads
 *     `<root>/scripts/*` and `<root>/scripts/sentry-suite-manifest.json`.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.SENTRY_SUITE_GATE_ROOT
  ? realpathSync(process.env.SENTRY_SUITE_GATE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS_DIR = join(ROOT, "scripts");
const MANIFEST_PATH = join(SCRIPTS_DIR, "sentry-suite-manifest.json");

/**
 * Stable repo-relative name for the manifest, named in every failure message so
 * a contributor who adds, renames, splits, or shrinks a suite sees exactly which
 * file to edit — the absolute MANIFEST_PATH differs under a fixture root.
 */
const MANIFEST_LABEL = "scripts/sentry-suite-manifest.json";

/** Node flags that force a deterministic node:test spec report regardless of TTY or minor version. */
const NODE_TEST_REPORTER_ARGS = [
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
];

/** A fatal, structural failure the gate cannot proceed past (env, manifest, set drift). */
class GateError extends Error {}

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
 * Load and shallow-validate the manifest. A malformed manifest is a fatal
 * fail-closed condition, not a skip.
 *
 * @param {string} path
 * @returns {{ suites: Record<string, object> }}
 */
export function loadManifest(path = MANIFEST_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new GateError(
      `cannot read ${MANIFEST_LABEL} (${path}): ${err.message}. This file is the gate's source of truth — it must exist and list every scripts/sentry-*.test.mjs.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GateError(
      `${MANIFEST_LABEL} is not valid JSON: ${err.message}. Fix the JSON syntax in ${MANIFEST_LABEL}.`,
    );
  }
  if (!parsed || typeof parsed.suites !== "object" || parsed.suites === null) {
    throw new GateError(
      `${MANIFEST_LABEL} has no "suites" object. Give it a top-level "suites" map of "scripts/sentry-<x>.test.mjs" to its reporter and floor.`,
    );
  }
  for (const [key, entry] of Object.entries(parsed.suites)) {
    if (!entry || typeof entry !== "object") {
      throw new GateError(
        `the entry for ${key} in ${MANIFEST_LABEL} is not an object — give it { "reporter": …, "floor": … }.`,
      );
    }
    const reporters = ["count-line", "node-test", "exit-only"];
    if (!reporters.includes(entry.reporter)) {
      throw new GateError(
        `${key} has an unknown reporter ${JSON.stringify(entry.reporter)} in ${MANIFEST_LABEL} — set "reporter" to one of ${reporters
          .map((r) => `"${r}"`)
          .join(", ")}.`,
      );
    }
    if (entry.exempt) {
      if (typeof entry.exempt.importer !== "string") {
        throw new GateError(
          `the exempt entry for ${key} in ${MANIFEST_LABEL} is missing an "importer" — name the file whose static import keeps the suite running in another job.`,
        );
      }
    } else if (!Number.isInteger(entry.floor) || entry.floor < 1) {
      throw new GateError(
        `${key} needs an integer "floor" >= 1 in ${MANIFEST_LABEL} (got ${JSON.stringify(
          entry.floor,
        )}) — set it to the suite's current pass count.`,
      );
    }
  }
  return parsed;
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
  const passFail = combined.match(/^(\d+) passed, (\d+) failed$/m);
  if (passFail) {
    return { pass: Number(passFail[1]), fail: Number(passFail[2]), caseLines };
  }
  const failPass = combined.match(/^(\d+) failed, (\d+) passed$/m);
  if (failPass) {
    return { pass: Number(failPass[2]), fail: Number(failPass[1]), caseLines };
  }
  const passOnly = combined.match(/^(\d+) passed$/m);
  if (passOnly) {
    return { pass: Number(passOnly[1]), fail: 0, caseLines };
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
  const importerPath = join(root, exempt.importer);
  let importerText;
  try {
    importerText = readFileSync(importerPath, "utf8");
  } catch (err) {
    reasons.push(`importer ${exempt.importer} unreadable: ${err.message}`);
    return reasons;
  }
  const base = suite.slice(suite.lastIndexOf("/") + 1);
  if (!importerText.includes(`./${base}`)) {
    reasons.push(
      `importer ${exempt.importer} no longer imports ./${base}; the exemption is dead`,
    );
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const routed = Object.values(pkg.scripts || {}).some(
      (cmd) => typeof cmd === "string" && cmd.includes(exempt.importer),
    );
    if (!routed) {
      reasons.push(
        `no package.json script runs ${exempt.importer}; \`${exempt.via || "the exempt route"}\` proves nothing`,
      );
    }
  } catch (err) {
    reasons.push(`package.json unreadable for route check: ${err.message}`);
  }
  return reasons;
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
    manifest = loadManifest();
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
  const rows = [];
  let failures = 0;
  for (const suite of manifestKeys) {
    const entry = manifest.suites[suite];
    if (entry.exempt) {
      const reasons = verifyExemptRoute(suite, entry.exempt, ROOT);
      rows.push({
        suite,
        status: reasons.length ? "ROUTE-BROKEN" : "exempt",
        detail:
          reasons.join("; ") ||
          `runs in ${entry.exempt.runBy || "another job"}`,
      });
      if (reasons.length) failures += 1;
      continue;
    }
    const result = runSuite(suite, entry, { root: ROOT });
    const reasons = judgeSuite(result, entry);
    rows.push({
      suite,
      status: reasons.length ? "FAIL" : "ok",
      detail: reasons.length
        ? reasons.join("; ")
        : `pass=${result.pass} floor=${entry.floor} lines=${result.caseLines}`,
    });
    if (reasons.length) failures += 1;
  }

  const table = [
    "",
    "## Sentry-suite gate",
    "",
    "| suite | status | detail |",
    "| ----- | ------ | ------ |",
    ...rows.map((r) => `| ${r.suite} | ${r.status} | ${r.detail} |`),
    "",
    failures === 0
      ? `All ${rows.length} manifest entries reconciled and asserted from their own output.`
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
