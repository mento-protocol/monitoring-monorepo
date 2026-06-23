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

const HIGH_SEVERITIES = new Set(["high", "critical"]);
const DISCORD_UNDICI_ADVISORY_IDS = new Set([
  "GHSA-vxpw-j846-p89q",
  "CVE-2026-12151",
]);
const ROOT_DISCORD_UNDICI_PATHS = new Set([
  "governance-watchdog>discord.js>undici",
  "governance-watchdog>discord.js>@discordjs/rest>undici",
]);
const GOVERNANCE_STANDALONE_DISCORD_UNDICI_PATHS = new Set([
  ".>discord.js>undici",
  ".>discord.js>@discordjs/rest>undici",
  "discord.js>undici",
  "discord.js>@discordjs/rest>undici",
]);

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
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
function isGovernanceWatchdogAudit(options) {
  const normalizedDir = options.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedDir === "governance-watchdog" ||
    normalizedDir.endsWith("/governance-watchdog") ||
    options.label === "governance-watchdog"
  );
}

/**
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
function isRootAudit(options) {
  const normalizedDir = options.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedDir === "." || normalizedDir === "" || options.label === "root"
  );
}

/**
 * @param {Record<string, any>} advisory
 * @param {Record<string, any>} finding
 * @param {string} path
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
function isAllowedDiscordUndiciFinding(advisory, finding, path, options) {
  if (advisory.module_name !== "undici") return false;
  if (finding.version !== "6.24.1") return false;
  if (
    !(isRootAudit(options) && ROOT_DISCORD_UNDICI_PATHS.has(path)) &&
    !(
      isGovernanceWatchdogAudit(options) &&
      GOVERNANCE_STANDALONE_DISCORD_UNDICI_PATHS.has(path)
    )
  ) {
    return false;
  }

  return advisoryIds(advisory).some((id) =>
    DISCORD_UNDICI_ADVISORY_IDS.has(id),
  );
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
 * @returns {{allowed: string[]; disallowed: string[]}}
 */
function evaluateReport(report, options) {
  if (report.error) {
    const message = report.error.message ?? JSON.stringify(report.error);
    die(`pnpm audit failed: ${message}`);
  }

  const allowed = [];
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
      if (isAllowedDiscordUndiciFinding(advisory, finding, path, options)) {
        allowed.push(summary);
      } else {
        disallowed.push(summary);
      }
    }
  }

  return { allowed, disallowed };
}

const options = parseArgs(process.argv.slice(2));
const report = loadAuditReport(options);
const { allowed, disallowed } = evaluateReport(report, options);

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
