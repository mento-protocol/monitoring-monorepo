/**
 * Fixture helpers shared by the sentry-suite gate's own suites.
 *
 * Deliberately NOT named `sentry-*.test.mjs`: `findSentrySuites` enumerates that
 * pattern, and this module holds no tests, so a name it matched would make the
 * gate try to run a file with no cases and no summary.
 *
 * It exists so `runGate` has exactly one definition. That helper is now
 * load-bearing rather than convenience — it is what keeps fixture gates from
 * writing their tables into the real `$GITHUB_STEP_SUMMARY` — and two copies of
 * it across two suites could drift apart silently, which is the class of bug
 * these suites exist to catch.
 *
 * Dependency-free (node builtins only), like everything the gate spawns.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The real gate, spawned against throwaway fixture roots. */
export const GATE = fileURLToPath(
  new URL("./sentry-suite-gate.mjs", import.meta.url),
);

/** The R1 injection: neuters a plain `node <suite>` into a silent exit 0. */
export const EVIL = "--import=data:text/javascript,process.exit(0)";

/** A throwaway repository root: `scripts/` plus a minimal package.json. */
export function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "sentry-gate-fixture-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
  return root;
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

export function writeSuite(root, name, body) {
  const target = join(root, "scripts", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

export function writeManifest(root, suites) {
  mkdirSync(join(root, "scripts", "sentry", "gate"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "sentry", "gate", "sentry-suite-manifest.json"),
    JSON.stringify({ suites }, null, 2),
  );
}

/** A count-line fixture: `count` `ok` lines and a matching `<count> passed`. */
export function countLineSuite(count) {
  return [
    `for (let i = 0; i < ${count}; i += 1) {`,
    `  process.stdout.write("ok case " + i + "\\n");`,
    `}`,
    `process.stdout.write("${count} passed\\n");`,
    ``,
  ].join("\n");
}

/** A node:test fixture with `count` trivial passing cases. */
export function nodeTestSuite(count) {
  return [
    `import { test } from "node:test";`,
    ...Array.from({ length: count }, (_, i) => `test("case ${i}", () => {});`),
    ``,
  ].join("\n");
}

/**
 * Spawn the real gate against a fixture root, in an environment scrubbed of
 * every variable the gate consults.
 *
 * Derived from the gate's own `process.env` reads rather than guessed, which is
 * the same discipline the watch set uses:
 *
 *   SENTRY_SUITE_GATE_ROOT — set here, to the fixture;
 *   GITHUB_STEP_SUMMARY    — REDIRECTED to a temp file, not deleted, so the
 *                            fixtures still exercise the summary-writing path
 *                            instead of silently skipping it;
 *   NODE_OPTIONS/NODE_PATH — cleared, so a developer's ambient value neither
 *                            trips the gate's refuse-to-start guard in every
 *                            fixture nor changes what the children run.
 *
 * Redirecting the summary is the load-bearing part. Inside the `sentry-suites`
 * job `process.env.GITHUB_STEP_SUMMARY` points at the real summary, so before
 * this every fixture gate appended its table to it: 94 lines across 11 tables,
 * including 9 `failed the gate` and 4 `TAMPERED` rows, in a job that SUCCEEDED.
 * An operator reading that cannot tell fixture output from the real verdict.
 *
 * `extraEnv` is applied last, so a test that deliberately sets NODE_OPTIONS
 * still can.
 */
export function runGate(root, extraEnv = {}) {
  const env = { ...process.env, SENTRY_SUITE_GATE_ROOT: root };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const summaryPath = join(root, "fixture-step-summary.md");
  env.GITHUB_STEP_SUMMARY = summaryPath;
  const child = spawnSync("node", [GATE], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  });
  let summary = "";
  try {
    summary = readFileSync(summaryPath, "utf8");
  } catch {
    // The gate writes a summary only when it gets that far; absence is a fact
    // the caller can assert on, not an error here.
  }
  return {
    status: child.status,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    summary,
    summaryPath,
  };
}

/**
 * The minimal count-line harness every sentry suite carries: `ok <name>` per
 * pass, `not ok <name>` per failure, and a `<n> passed` summary the gate parses.
 * Returned as a closure set so each suite keeps its own counters.
 */
export function makeHarness() {
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

  /**
   * MUST be the last thing a suite does: every `await test(...)` has to settle
   * before the totals print, or a case below this prints an `ok` the summary
   * never counts (the skew the gate's `pass == emitted-lines` check catches).
   */
  function summarize() {
    if (failed > 0) {
      process.stderr.write(`${failed} failed, ${passed} passed\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${passed} passed\n`);
    }
  }

  return { test, assert, assertEqual, summarize };
}
