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
import { createHash } from "node:crypto";
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
 * The gate's own source, repo-relative. Hashed alongside the suites: a suite
 * that rewrites the runner mid-flight would otherwise change how its own
 * successors are judged.
 */
const GATE_LABEL = "scripts/sentry-suite-gate.mjs";

/** The second half of every exemption route proof: it must run the importer. */
const PACKAGE_JSON_LABEL = "package.json";

/**
 * The manifest schema, as an ALLOWLIST.
 *
 * Same inversion as the CI-job pin: enumerating bad values could not converge,
 * because every field here is honoured verbatim by the runner. `nodeArgs` is
 * spread into node's argv and `exempt` skips execution outright, so both were
 * usable to pass a throwing suite (both measured). A field the schema does not
 * list cannot influence a run, whatever a future edit calls it.
 */
const MANIFEST_TOP_LEVEL_KEYS = ["_readme", "suites"];
const ENTRY_KEYS = ["reporter", "floor", "nodeArgs", "exempt"];

/** The only `nodeArgs` the design needs: the node:test runner. */
const SUPPORTED_NODE_ARGS = ["--test"];

/** The one suite that may be exempt, and the exact route ADR 0062 records. */
const EXEMPT_SUITE = "scripts/sentry-provider-contract.test.mjs";
const EXEMPT_ROUTE = {
  runBy: "production-infra-contract",
  via: "pnpm tf:test",
  importer: "scripts/tf-stacks.test.mjs",
};

/** Escape a literal for embedding in a RegExp. */
function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Static `import` specifiers of a module, with comments stripped first.
 *
 * The route check used to substring-match the suite's basename against the
 * importer's raw text, which a comment mentioning the path satisfied (measured:
 * a one-line comment plus an `echo` package script passed the whole exemption).
 * Parsing the actual import statements is what makes the route real.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function staticImportSpecifiers(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specifiers = [];
  const pattern =
    /\bimport\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(withoutComments)) !== null) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

/**
 * SHA-256 of a file's bytes, or `null` when it cannot be read (deleted mid-run
 * is itself a tamper signal, so the caller reports the difference rather than
 * throwing here).
 *
 * @param {string} path
 * @returns {string | null}
 */
export function digestFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Digest every file whose bytes must not change while the gate runs: each
 * manifest-listed suite, the manifest itself, and the gate's own source.
 *
 * Every child shares one writable checkout, so without this an alphabetically
 * earlier suite can overwrite a later one with a program that prints the
 * expected `ok` lines and a matching summary — both then report passing and the
 * gate's central claim, that each suite's result came from that suite, is void.
 * Reproduced before this existed: a `sentry-aaa-attacker` suite rewrote
 * `sentry-zzz-victim` (a genuinely failing suite) and the gate exited 0 with
 * both rows `ok`.
 *
 * @param {string[]} suites repo-relative suite paths
 * @param {string} root
 * @returns {Map<string, string | null>} repo-relative path to digest
 */
export function digestWatchSet(manifest, root) {
  return new Map(
    gateInputs(manifest).map((relative) => [
      relative,
      digestFile(join(root, relative)),
    ]),
  );
}

/**
 * Every file the gate READS in order to decide anything, derived from the
 * manifest rather than listed by hand.
 *
 * The watch set was twice decided by asking "which files feel load-bearing",
 * and twice missed one: the exemption route trusts BOTH the importer named in
 * the entry and `package.json` (it must contain a script that runs that
 * importer), and neither was watched — so an earlier alphabetic suite could
 * restore the import in the job's writable checkout and forge an intact route
 * for a suite the production job never runs (measured: gate exit 0 on a
 * throwing exempt suite).
 *
 * The right question is what the gate consults to reach a verdict, so this
 * derives that set from the decision inputs themselves:
 *
 *   - the manifest — decides the expected set, floors, reporters, exemptions;
 *   - the gate's own source — decides how every result is judged;
 *   - every manifest-listed suite — the thing whose output is the verdict;
 *   - per exempt entry, its `importer` and `package.json` — the only evidence
 *     that an unrun suite still runs somewhere else.
 *
 * Anything added to the manifest that brings a new input with it lands in the
 * watch set automatically, which is the property the hand-written list lacked.
 *
 * @param {{ suites: Record<string, any> }} manifest
 * @returns {string[]} repo-relative paths, sorted
 */
export function gateInputs(manifest) {
  const inputs = new Set([MANIFEST_LABEL, GATE_LABEL]);
  for (const [suite, entry] of Object.entries(manifest?.suites ?? {})) {
    inputs.add(suite);
    if (!entry?.exempt) continue;
    // Both halves of the route proof, per ADR 0062.
    inputs.add(entry.exempt.importer);
    inputs.add(PACKAGE_JSON_LABEL);
  }
  return [...inputs].sort();
}

/**
 * Compare current bytes against the pre-run snapshot.
 *
 * @param {Map<string, string | null>} baseline
 * @param {string} root
 * @param {string[]} [only] restrict the check to these paths; default all
 * @returns {string[]} human-readable descriptions of every file that changed
 */
export function digestDrift(baseline, root, only) {
  const paths = only ?? [...baseline.keys()];
  const drift = [];
  for (const relative of paths) {
    const before = baseline.get(relative);
    const now = digestFile(join(root, relative));
    if (before === now) continue;
    if (now === null) {
      drift.push(`${relative} was DELETED while the gate was running`);
    } else if (before === null) {
      drift.push(`${relative} was CREATED while the gate was running`);
    } else {
      drift.push(
        `${relative} was REWRITTEN while the gate was running (${before.slice(0, 12)} → ${now.slice(0, 12)})`,
      );
    }
  }
  return drift;
}

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
  // Top-level keys by allowlist, same discipline as the suite set itself.
  for (const key of Object.keys(parsed)) {
    if (MANIFEST_TOP_LEVEL_KEYS.includes(key)) continue;
    throw new GateError(
      `${MANIFEST_LABEL} has an unrecognised top-level key "${key}" — only ${MANIFEST_TOP_LEVEL_KEYS.map(
        (k) => `"${k}"`,
      ).join(" and ")} are allowed.`,
    );
  }

  for (const [key, entry] of Object.entries(parsed.suites)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GateError(
        `the entry for ${key} in ${MANIFEST_LABEL} is not an object — give it { "reporter": …, "floor": … }.`,
      );
    }

    // Per-entry keys by allowlist. A field nobody has thought of cannot change
    // how a suite is run if the schema refuses to carry it.
    for (const field of Object.keys(entry)) {
      if (ENTRY_KEYS.includes(field)) continue;
      throw new GateError(
        `${key} has an unrecognised field "${field}" in ${MANIFEST_LABEL} — entries carry only ${ENTRY_KEYS.map(
          (f) => `"${f}"`,
        ).join(
          ", ",
        )}; anything else is rejected rather than silently honoured.`,
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

    // `nodeArgs` is spread verbatim into the spawn, so an arbitrary value is
    // arbitrary control over node's argv: `["--eval", "console.log('1 passed')"]`
    // makes node treat the suite PATH as a positional argument and never run it,
    // so a throwing suite is judged green (measured). Only the one invocation
    // the design actually needs is permitted, matched exactly.
    if (entry.nodeArgs !== undefined) {
      const encoded = JSON.stringify(entry.nodeArgs);
      if (encoded !== JSON.stringify(SUPPORTED_NODE_ARGS)) {
        throw new GateError(
          `${key} sets "nodeArgs": ${encoded} in ${MANIFEST_LABEL} — the only supported value is ` +
            `${JSON.stringify(SUPPORTED_NODE_ARGS)} (the node:test runner). nodeArgs is passed straight to ` +
            "node, so anything else can stop the suite from running at all.",
        );
      }
      if (entry.reporter !== "node-test") {
        throw new GateError(
          `${key} sets "nodeArgs" with reporter "${entry.reporter}" in ${MANIFEST_LABEL} — ` +
            `${JSON.stringify(SUPPORTED_NODE_ARGS)} is only meaningful for the "node-test" reporter.`,
        );
      }
    }

    if (entry.exempt !== undefined) {
      // Exemption skips execution and every count check, so it is the single
      // most powerful field here: marking any suite exempt hides it entirely
      // (measured — a throwing suite reported `exempt` at exit 0). It is
      // therefore permitted for exactly one suite, with exactly the route ADR
      // 0062 records, compared structurally rather than field-by-field.
      if (key !== EXEMPT_SUITE) {
        throw new GateError(
          `${key} is marked "exempt" in ${MANIFEST_LABEL}, but exemption is reserved for ` +
            `${EXEMPT_SUITE} alone. Every other suite must be RUN by the gate; exempting one ` +
            "skips its execution and all of its count checks.",
        );
      }
      const encoded = JSON.stringify(
        entry.exempt,
        Object.keys(EXEMPT_ROUTE).sort(),
      );
      const expected = JSON.stringify(
        EXEMPT_ROUTE,
        Object.keys(EXEMPT_ROUTE).sort(),
      );
      if (
        encoded !== expected ||
        Object.keys(entry.exempt).sort().join() !==
          Object.keys(EXEMPT_ROUTE).sort().join()
      ) {
        throw new GateError(
          `${key}'s "exempt" route in ${MANIFEST_LABEL} is ${JSON.stringify(entry.exempt)}, but the only ` +
            `route ADR 0062 records is ${expected}. The route is matched exactly, so it cannot be ` +
            "pointed at a different job or importer.",
        );
      }
      if (entry.floor !== undefined) {
        throw new GateError(
          `${key} is exempt but also carries a "floor" in ${MANIFEST_LABEL} — an exempt suite is ` +
            "never run here, so a floor on it would be meaningless.",
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
  const importerPath = join(root, exempt.importer);
  let importerText;
  try {
    importerText = readFileSync(importerPath, "utf8");
  } catch (err) {
    reasons.push(`importer ${exempt.importer} unreadable: ${err.message}`);
    return reasons;
  }
  // A real static import, not a mention. Substring-matching the raw text was
  // satisfied by a comment naming the path.
  const base = suite.slice(suite.lastIndexOf("/") + 1);
  const specifiers = staticImportSpecifiers(importerText);
  if (!specifiers.includes(`./${base}`)) {
    reasons.push(
      `importer ${exempt.importer} has no static import of ./${base} (its imports are ` +
        `${JSON.stringify(specifiers)}); the exemption is dead`,
    );
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // The script must actually RUN the importer with node, not merely mention
    // it — `echo scripts/tf-stacks.test.mjs` satisfied a substring check.
    const runner = new RegExp(
      `(^|&&|\\|\\||;)\\s*node\\s+(--[\\w-]+(=\\S+)?\\s+)*${escapeForRegExp(exempt.importer)}(\\s|$)`,
    );
    const routed = Object.values(pkg.scripts || {}).some(
      (cmd) => typeof cmd === "string" && runner.test(cmd),
    );
    if (!routed) {
      reasons.push(
        `no package.json script runs \`node ${exempt.importer}\`; \`${exempt.via || "the exempt route"}\` proves nothing`,
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
  //
  // Snapshot every watched file BEFORE any child runs. Each child then gets its
  // own file re-checked immediately before its spawn (so a tamper message can
  // name the suite and the point it was caught), and every digest is re-verified
  // after the last child (so a rewrite is caught no matter the ordering — an
  // attacker rewriting a suite that already ran is still caught by the sweep).
  const baseline = digestWatchSet(manifest, ROOT);

  const rows = [];
  let failures = 0;
  for (const suite of manifestKeys) {
    const entry = manifest.suites[suite];
    if (entry.exempt) {
      // The route is evidence about code this gate never runs, so its inputs
      // must be the ones committed, not ones an earlier suite just rewrote.
      const routeDrift = digestDrift(baseline, ROOT, [
        entry.exempt.importer,
        PACKAGE_JSON_LABEL,
      ]);
      if (routeDrift.length > 0) {
        rows.push({
          suite,
          status: "TAMPERED",
          detail: `${routeDrift.join("; ")} — refusing to accept the exemption; an earlier suite in this gate run modified the evidence for it`,
        });
        failures += 1;
        continue;
      }
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
    // Re-check THIS suite's bytes immediately before spawning it: if an earlier
    // suite rewrote it, the result about to be produced is not this suite's.
    const preSpawnDrift = digestDrift(baseline, ROOT, [suite]);
    if (preSpawnDrift.length > 0) {
      rows.push({
        suite,
        status: "TAMPERED",
        detail: `${preSpawnDrift.join("; ")} — refusing to run it; an earlier suite in this gate run modified it`,
      });
      failures += 1;
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
    if (reasons.length) {
      failures += 1;
      // A summary row names WHICH suite broke but never why, which leaves a
      // contributor re-running the suite by hand to find out. Echo the failing
      // suite's own diagnostics — the `not ok` / `✖` lines and any stack — so
      // the gate's output is self-contained.
      const detail = `${result.stdout}\n${result.stderr}`
        .split("\n")
        .filter((line) => /^(not ok |✖|\s+(Error|AssertionError))/.test(line))
        .slice(0, 20);
      if (detail.length > 0) {
        process.stderr.write(
          `\n--- ${suite} reported:\n${detail.join("\n")}\n`,
        );
      }
    }
  }

  // The sweep that makes the guarantee ordering-independent: re-verify EVERY
  // watched file after the last child. A suite that rewrote one which already
  // ran, or that rewrote the manifest or this runner, is caught here even
  // though no per-spawn check could have seen it.
  // Enumeration is a decision input too: set equality was computed once, before
  // any child ran, so a suite CREATED mid-run would never be reconciled and a
  // digest sweep over known files cannot see it. Re-enumerate and compare.
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

  const finalDrift = digestDrift(baseline, ROOT);
  for (const change of finalDrift) {
    rows.push({
      suite: change.split(" ")[0],
      status: "TAMPERED",
      detail: `${change} — a suite modified a watched file; every result in this run is untrustworthy`,
    });
    failures += 1;
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
