#!/usr/bin/env node
/**
 * Fail-closed high/critical pnpm audit gate with narrow documented exceptions.
 *
 * The supply-chain workflow normally blocks every high/critical advisory. The
 * only current exception is the Discord-owned undici pin in governance-watchdog:
 * discord.js 14.26.4 pins undici 6.24.1 exactly, and forcing a newer undici
 * through overrides has already broken Discord delivery. Keep that exception
 * advisory-, module-, version-, and path-scoped so unrelated undici consumers
 * still fail the gate.
 *
 * Run:
 *   node scripts/pnpm-audit-high-gate.mjs --dir .
 *   node scripts/pnpm-audit-high-gate.mjs --dir governance-watchdog
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateAuditReport,
  isBlockingSeverity,
} from "./pnpm-audit-classifier.mjs";

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string[]} argv
 * @returns {{dir: string; auditJsonPath?: string; label: string}}
 */
function parseArgs(argv) {
  /** @type {{dir: string; auditJsonPath?: string; label: string}} */
  const parsed = { dir: ".", label: "root" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[++i];
      if (!value) die("--dir requires a value");
      parsed.dir = value;
    } else if (arg === "--audit-json") {
      const value = argv[++i];
      if (!value) die("--audit-json requires a value");
      parsed.auditJsonPath = value;
    } else if (arg === "--label") {
      const value = argv[++i];
      if (!value) die("--label requires a value");
      parsed.label = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/pnpm-audit-high-gate.mjs [--dir <path>] [--label <name>] [--audit-json <path>]",
      );
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

/**
 * @param {string} raw
 * @param {string} source
 * @returns {Record<string, any>}
 */
function parseAuditJson(raw, source) {
  try {
    return JSON.parse(raw);
  } catch {
    die(`pnpm audit for ${source} did not produce JSON: ${raw.slice(0, 500)}`);
  }
}

/**
 * @param {{dir: string; auditJsonPath?: string}} options
 * @returns {Record<string, any>}
 */
function loadAuditReport({ dir, auditJsonPath }) {
  if (auditJsonPath) {
    return parseAuditJson(readFileSync(auditJsonPath, "utf8"), auditJsonPath);
  }

  const cwd = resolve(dir);
  const result = spawnSync("pnpm", ["audit", "--audit-level=high", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    die(`Failed to run pnpm audit in ${cwd}: ${result.error.message}`);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!stdout.trim()) {
    die(
      `pnpm audit in ${cwd} produced no JSON` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
    );
  }

  const report = parseAuditJson(stdout, cwd);
  if (
    result.status !== 0 &&
    Object.keys(report.advisories ?? {}).length === 0
  ) {
    die(
      `pnpm audit in ${cwd} exited ${result.status ?? "unknown"} without advisory data` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
    );
  }

  return report;
}

const options = parseArgs(process.argv.slice(2));
const report = loadAuditReport(options);
let evaluated;
try {
  evaluated = evaluateAuditReport(report, options, {
    includeAdvisory: isBlockingSeverity,
  });
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
const { allowed, disallowed } = evaluated;

if (disallowed.length > 0) {
  console.error(`${options.label}: disallowed high/critical pnpm advisories:`);
  for (const item of disallowed) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

if (allowed.length > 0) {
  console.log(`${options.label}: allowed documented advisory path(s):`);
  for (const item of allowed) {
    console.log(`- ${item}`);
  }
} else {
  console.log(`${options.label}: no high/critical pnpm advisories`);
}
