#!/usr/bin/env node
/**
 * Fixture tests for scripts/pnpm-audit-moderate-report.mjs.
 *
 * Run: node scripts/pnpm-audit-moderate-report.test.mjs
 */

import {
  dedupeAdvisories,
  reportableAdvisories,
} from "./pnpm-audit-moderate-report.mjs";

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
 * @param {string} path
 * @param {string} id
 * @param {string} severity
 * @returns {Record<string, unknown>}
 */
function undiciAdvisory(path, id, severity) {
  return {
    module_name: "undici",
    severity,
    github_advisory_id: id,
    title: "undici advisory",
    vulnerable_versions: "<6.27.0",
    patched_versions: ">=6.27.0",
    findings: [{ version: "6.24.1", paths: [path] }],
  };
}

console.log("\npnpm-audit-moderate-report.mjs fixture tests\n");

test("filters documented standalone Discord undici advisories", () => {
  const records = reportableAdvisories(
    {
      advisories: {
        high: undiciAdvisory(
          ".>discord.js>@discordjs/ws>@discordjs/rest>undici",
          "GHSA-vxpw-j846-p89q",
          "high",
        ),
        moderate: undiciAdvisory(
          ".>discord.js>@discordjs/rest>undici",
          "GHSA-p88m-4jfj-68fv",
          "moderate",
        ),
      },
    },
    "governance-watchdog",
  );

  assert(records.length === 0, `expected no records, got ${records.length}`);
});

test("reports unrelated moderate advisories", () => {
  const records = reportableAdvisories(
    {
      advisories: {
        example: {
          module_name: "example",
          severity: "moderate",
          github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
          title: "example issue",
          vulnerable_versions: "<1.2.3",
          patched_versions: ">=1.2.3",
          findings: [{ version: "1.0.0", paths: [".>example"] }],
        },
      },
    },
    "root",
  );

  assert(records.length === 1, `expected one record, got ${records.length}`);
  assert(records[0]?.module_name === "example", "expected example record");
});

test("reports undici advisory through non-allowed consumers", () => {
  const records = reportableAdvisories(
    {
      advisories: {
        undici: undiciAdvisory(
          "ui-dashboard>@vercel/blob>undici",
          "GHSA-p88m-4jfj-68fv",
          "moderate",
        ),
      },
    },
    "root",
  );

  assert(records.length === 1, `expected one record, got ${records.length}`);
  assert(
    records[0]?.path === "ui-dashboard>@vercel/blob>undici",
    `unexpected path ${records[0]?.path}`,
  );
});

test("deduplicates advisories across lockfiles", () => {
  const records = dedupeAdvisories([
    {
      id: "GHSA-xxxx-yyyy-zzzz",
      module_name: "example",
      severity: "moderate",
      title: "example issue",
      vulnerable_versions: "<1.2.3",
      patched_versions: ">=1.2.3",
      version: "1.0.0",
      path: ".>example",
      lockfiles: ["root"],
    },
    {
      id: "GHSA-xxxx-yyyy-zzzz",
      module_name: "example",
      severity: "moderate",
      title: "example issue",
      vulnerable_versions: "<1.2.3",
      patched_versions: ">=1.2.3",
      version: "1.0.0",
      path: ".>example",
      lockfiles: ["governance-watchdog"],
    },
  ]);

  assert(records.length === 1, `expected one record, got ${records.length}`);
  assert(
    records[0]?.lockfiles.join(",") === "governance-watchdog,root",
    `unexpected lockfiles ${records[0]?.lockfiles.join(",")}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
