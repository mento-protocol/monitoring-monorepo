#!/usr/bin/env node
/**
 * Fixture tests for scripts/pnpm-audit-high-gate.mjs.
 *
 * Run: node scripts/pnpm-audit-high-gate.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const SCRIPT = new URL("./pnpm-audit-high-gate.mjs", import.meta.url).pathname;

/**
 * @param {unknown} report
 * @param {string[]} [args]
 * @returns {{exitCode: number; stdout: string; stderr: string}}
 */
function run(report, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-audit-high-gate-test-"));
  try {
    const reportPath = join(dir, "audit.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--audit-json", reportPath, "--label", "fixture", ...args],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} path
 * @param {string} [version]
 * @returns {Record<string, unknown>}
 */
function undiciCve(path, version = "6.24.1") {
  return {
    module_name: "undici",
    severity: "high",
    github_advisory_id: "GHSA-vxpw-j846-p89q",
    cves: ["CVE-2026-12151"],
    findings: [{ version, paths: [path] }],
  };
}

console.log("\npnpm-audit-high-gate.mjs fixture tests\n");

test("passes when there are no high advisories", () => {
  const { exitCode, stdout } = run({ advisories: {} });
  assert(exitCode === 0, `expected exit 0, got ${exitCode}`);
  assert(stdout.includes("no high/critical"), `stdout: ${stdout}`);
});

test("allows the documented root governance-watchdog Discord undici path", () => {
  const { exitCode, stdout, stderr } = run(
    {
      advisories: {
        123: undiciCve("governance-watchdog>discord.js>undici"),
      },
    },
    ["--dir", ".", "--label", "root"],
  );
  assert(exitCode === 0, `expected exit 0, got ${exitCode}: ${stderr}`);
  assert(stdout.includes("allowed documented"), `stdout: ${stdout}`);
});

test("allows the documented root Discord ws rest undici path", () => {
  const { exitCode, stdout, stderr } = run(
    {
      advisories: {
        123: undiciCve(
          "governance-watchdog>discord.js>@discordjs/ws>@discordjs/rest>undici",
        ),
      },
    },
    ["--dir", ".", "--label", "root"],
  );
  assert(exitCode === 0, `expected exit 0, got ${exitCode}: ${stderr}`);
  assert(stdout.includes("@discordjs/ws"), `stdout: ${stdout}`);
});

test("allows the documented standalone governance-watchdog Discord undici path", () => {
  const { exitCode, stdout, stderr } = run(
    {
      advisories: {
        123: undiciCve("discord.js>undici"),
      },
    },
    ["--dir", "governance-watchdog", "--label", "governance-watchdog"],
  );
  assert(exitCode === 0, `expected exit 0, got ${exitCode}: ${stderr}`);
  assert(stdout.includes("discord.js>undici"), `stdout: ${stdout}`);
});

test("allows pnpm's dot-prefixed standalone Discord undici path", () => {
  const { exitCode, stdout, stderr } = run(
    {
      advisories: {
        123: undiciCve(".>discord.js>undici"),
      },
    },
    ["--dir", "governance-watchdog", "--label", "governance-watchdog"],
  );
  assert(exitCode === 0, `expected exit 0, got ${exitCode}: ${stderr}`);
  assert(stdout.includes(".>discord.js>undici"), `stdout: ${stdout}`);
});

test("allows the documented standalone Discord ws rest undici path", () => {
  const { exitCode, stdout, stderr } = run(
    {
      advisories: {
        123: undiciCve(".>discord.js>@discordjs/ws>@discordjs/rest>undici"),
      },
    },
    ["--dir", "governance-watchdog", "--label", "governance-watchdog"],
  );
  assert(exitCode === 0, `expected exit 0, got ${exitCode}: ${stderr}`);
  assert(stdout.includes("@discordjs/ws"), `stdout: ${stdout}`);
});

test("rejects unqualified standalone Discord paths outside governance-watchdog", () => {
  const { exitCode, stderr } = run(
    {
      advisories: {
        123: undiciCve(".>discord.js>undici"),
      },
    },
    ["--dir", "alerts/infra/oncall-announcer", "--label", "alerts/oncall"],
  );
  assert(exitCode !== 0, "expected non-zero exit");
  assert(stderr.includes(".>discord.js>undici"), `stderr: ${stderr}`);
});

test("rejects root-prefixed Discord paths outside root audits", () => {
  const { exitCode, stderr } = run(
    {
      advisories: {
        123: undiciCve("governance-watchdog>discord.js>undici"),
      },
    },
    ["--dir", "alerts/infra/oncall-announcer", "--label", "alerts/oncall"],
  );
  assert(exitCode !== 0, "expected non-zero exit");
  assert(
    stderr.includes("governance-watchdog>discord.js>undici"),
    `stderr: ${stderr}`,
  );
});

test("rejects the same undici CVE through a different consumer", () => {
  const { exitCode, stderr } = run({
    advisories: {
      123: undiciCve("ui-dashboard>@vercel/blob>undici"),
    },
  });
  assert(exitCode !== 0, "expected non-zero exit");
  assert(stderr.includes("disallowed high/critical"), `stderr: ${stderr}`);
  assert(stderr.includes("@vercel/blob"), `stderr: ${stderr}`);
});

test("rejects the Discord path when the pinned version changes", () => {
  const { exitCode, stderr } = run({
    advisories: {
      123: undiciCve("governance-watchdog>discord.js>undici", "6.26.0"),
    },
  });
  assert(exitCode !== 0, "expected non-zero exit");
  assert(stderr.includes("undici@6.26.0"), `stderr: ${stderr}`);
});

test("rejects unrelated high advisories", () => {
  const { exitCode, stderr } = run({
    advisories: {
      456: {
        module_name: "example",
        severity: "critical",
        github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
        findings: [{ version: "1.0.0", paths: ["pkg>example"] }],
      },
    },
  });
  assert(exitCode !== 0, "expected non-zero exit");
  assert(stderr.includes("example@1.0.0"), `stderr: ${stderr}`);
});

test("fails closed on pnpm audit error payloads", () => {
  const { exitCode, stderr } = run({
    error: { message: "registry unavailable" },
  });
  assert(exitCode !== 0, "expected non-zero exit");
  assert(stderr.includes("registry unavailable"), `stderr: ${stderr}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
