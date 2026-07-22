#!/usr/bin/env node
/**
 * Unit tests for scripts/lockfile-scope.mjs.
 *
 * Exercises the pure `classifyLockfileChange` classifier plus the CLI
 * exit-code contract the agent quality gate depends on.
 *
 * Run: node scripts/lockfile-scope.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyLockfileChange } from "./lockfile-scope.mjs";

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
    passed += 1;
  } catch (/** @type {unknown} */ err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`not ok ${name}`);
    console.error(`  ${message}`);
    failed += 1;
  }
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Minimal lockfile document with a couple importer sections and the
 * derivative top-level sections a real pnpm-lock.yaml carries.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function lockfile(overrides = {}) {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    overrides: {},
    importers: {
      ".": { dependencies: {} },
      "ui-dashboard": {
        dependencies: { react: { specifier: "^18.0.0", version: "18.0.0" } },
      },
      "indexer-envio": {
        dependencies: { viem: { specifier: "^2.0.0", version: "2.0.0" } },
      },
    },
    packages: { "react@18.0.0": {} },
    snapshots: { "react@18.0.0": {} },
    ...overrides,
  };
}

test("no change → scopable with empty importer list", () => {
  const result = classifyLockfileChange(lockfile(), lockfile());
  assert(result.scope === "importers", `scope: ${result.scope}`);
  assert(result.importers.length === 0, `importers: ${result.importers}`);
});

test("single importer changed → that importer only", () => {
  const head = lockfile();
  head.importers["ui-dashboard"].dependencies.react.version = "18.2.0";
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "importers", `scope: ${result.scope}`);
  assert(
    JSON.stringify(result.importers) === JSON.stringify(["ui-dashboard"]),
    `importers: ${JSON.stringify(result.importers)}`,
  );
});

test("two importers changed → both, sorted", () => {
  const head = lockfile();
  head.importers["ui-dashboard"].dependencies.react.version = "18.2.0";
  head.importers["indexer-envio"].dependencies.viem.version = "2.1.0";
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "importers", `scope: ${result.scope}`);
  assert(
    JSON.stringify(result.importers) ===
      JSON.stringify(["indexer-envio", "ui-dashboard"]),
    `importers: ${JSON.stringify(result.importers)}`,
  );
});

test("added importer section is reported", () => {
  const head = lockfile();
  head.importers["metrics-bridge"] = { dependencies: {} };
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "importers", `scope: ${result.scope}`);
  assert(
    JSON.stringify(result.importers) === JSON.stringify(["metrics-bridge"]),
    `importers: ${JSON.stringify(result.importers)}`,
  );
});

test("overrides change → full", () => {
  const head = lockfile({ overrides: { "cross-spawn": ">=7.0.5" } });
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "full", `scope: ${result.scope}`);
});

test("settings change → full", () => {
  const head = lockfile({
    settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
  });
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "full", `scope: ${result.scope}`);
});

test("packages/snapshots (transitive) change → full", () => {
  const head = lockfile();
  head.packages["left-pad@1.3.0"] = {};
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "full", `scope: ${result.scope}`);
});

test("lockfileVersion change → full", () => {
  const head = lockfile({ lockfileVersion: "9.1" });
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "full", `scope: ${result.scope}`);
});

test("patchedDependencies change → full", () => {
  const head = lockfile({
    patchedDependencies: { "foo@1.0.0": { hash: "abc", path: "patches/foo" } },
  });
  const result = classifyLockfileChange(lockfile(), head);
  assert(result.scope === "full", `scope: ${result.scope}`);
});

test("non-record input → full", () => {
  assert(
    classifyLockfileChange(null, lockfile()).scope === "full",
    "base null",
  );
  assert(
    classifyLockfileChange(lockfile(), "x").scope === "full",
    "head string",
  );
});

// ── CLI exit-code contract ─────────────────────────────────────────────────

const SCRIPT = new URL("./lockfile-scope.mjs", import.meta.url).pathname;

/**
 * @param {string} baseYaml
 * @param {string} headYaml
 * @returns {{ status: number | null, stdout: string }}
 */
function runCli(baseYaml, headYaml) {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-scope-"));
  try {
    const basePath = join(dir, "base.yaml");
    const headPath = join(dir, "head.yaml");
    writeFileSync(basePath, baseYaml);
    writeFileSync(headPath, headYaml);
    const result = spawnSync("node", [SCRIPT, basePath, headPath], {
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI: importer-only change exits 0 and prints importer", () => {
  const base =
    "importers:\n  ui-dashboard:\n    dependencies:\n      react: 18.0.0\n";
  const head =
    "importers:\n  ui-dashboard:\n    dependencies:\n      react: 18.2.0\n";
  const { status, stdout } = runCli(base, head);
  assert(status === 0, `status: ${status}`);
  assert(stdout.trim() === "ui-dashboard", `stdout: ${JSON.stringify(stdout)}`);
});

test("CLI: overrides change exits 1", () => {
  const base = "overrides: {}\nimporters:\n  ui-dashboard: {}\n";
  const head =
    "overrides:\n  cross-spawn: '>=7.0.5'\nimporters:\n  ui-dashboard: {}\n";
  const { status } = runCli(base, head);
  assert(status === 1, `status: ${status}`);
});

test("CLI: unparsable input exits 1 (fail toward full)", () => {
  const { status } = runCli(
    "importers:\n  a: [unterminated\n",
    "importers: {}\n",
  );
  assert(status === 1, `status: ${status}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
