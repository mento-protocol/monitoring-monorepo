#!/usr/bin/env node
/**
 * Fail-closed high/critical pnpm audit gate.
 *
 * Run:
 *   node scripts/pnpm-audit-high-gate.mjs --dir .
 *   node scripts/pnpm-audit-high-gate.mjs --dir governance-watchdog
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const HIGH_SEVERITIES = new Set(["high", "critical"]);

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

/**
 * @param {Record<string, any>} advisory
 * @returns {string[]}
 */
function advisoryIds(advisory) {
  return [
    advisory.github_advisory_id,
    ...(Array.isArray(advisory.cves) ? advisory.cves : []),
    advisory.url,
    advisory.id !== undefined ? String(advisory.id) : undefined,
  ].filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * @param {Record<string, any>} advisory
 * @returns {boolean}
 */
function isBlockingSeverity(advisory) {
  const severity = String(advisory.severity ?? "").toLowerCase();
  return severity === "" || HIGH_SEVERITIES.has(severity);
}

/**
 * @param {Record<string, any>} advisory
 * @returns {Array<{finding: Record<string, any>; path: string}>}
 */
function findingPaths(advisory) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  if (findings.length === 0) {
    return [{ finding: {}, path: "<missing finding path>" }];
  }

  return findings.flatMap((finding) => {
    const paths = Array.isArray(finding.paths) ? finding.paths : [];
    if (paths.length === 0) {
      return [{ finding, path: "<missing finding path>" }];
    }
    return paths.map((path) => ({ finding, path: String(path) }));
  });
}

/**
 * @param {Record<string, any>} report
 * @param {{dir: string; label: string}} options
 * @returns {string[]}
 */
function evaluateReport(report) {
  if (report.error) {
    const message = report.error.message ?? JSON.stringify(report.error);
    die(`pnpm audit failed: ${message}`);
  }

  const disallowed = [];
  const advisories = Object.values(report.advisories ?? {});

  for (const advisory of advisories) {
    if (!isBlockingSeverity(advisory)) continue;

    const ids = advisoryIds(advisory);
    const id = ids[0] ?? "unknown-advisory";
    const moduleName = advisory.module_name ?? "unknown-module";
    const severity = advisory.severity ?? "unknown-severity";

    for (const { finding, path } of findingPaths(advisory)) {
      const version = finding.version ?? "unknown-version";
      const summary = `${id} ${severity} ${moduleName}@${version} via ${path}`;
      disallowed.push(summary);
    }
  }

  return disallowed;
}

const options = parseArgs(process.argv.slice(2));
const report = loadAuditReport(options);
const disallowed = evaluateReport(report);

if (disallowed.length > 0) {
  console.error(`${options.label}: disallowed high/critical pnpm advisories:`);
  for (const item of disallowed) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log(`${options.label}: no high/critical pnpm advisories`);
