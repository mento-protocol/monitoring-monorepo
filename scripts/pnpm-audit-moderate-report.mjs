#!/usr/bin/env node
/**
 * Build the weekly moderate+ advisory issue payload from pnpm audit JSON files.
 *
 * The report intentionally filters the same documented Discord-owned undici
 * findings as the blocking high gate. Those findings are tracked by a scoped
 * exception because overriding Discord's exact undici pin has broken production
 * delivery before.
 *
 * Run:
 *   node scripts/pnpm-audit-moderate-report.mjs \
 *     --report root=/tmp/root.json \
 *     --report governance-watchdog=/tmp/governance-watchdog.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advisoryRecord,
  evaluateAuditReport,
  findingPaths,
  isAllowedDiscordUndiciFinding,
  isModeratePlusSeverity,
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
 * @returns {{reports: Array<{label: string; path: string}>}}
 */
function parseArgs(argv) {
  /** @type {Array<{label: string; path: string}>} */
  const reports = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") {
      const value = argv[++i];
      if (!value) die("--report requires LABEL=PATH");
      const splitAt = value.indexOf("=");
      if (splitAt <= 0 || splitAt === value.length - 1) {
        die("--report requires LABEL=PATH");
      }
      reports.push({
        label: value.slice(0, splitAt),
        path: value.slice(splitAt + 1),
      });
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/pnpm-audit-moderate-report.mjs --report LABEL=PATH [--report LABEL=PATH...]",
      );
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }

  if (reports.length === 0) die("at least one --report is required");
  return { reports };
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
 * @param {Record<string, any>} report
 * @param {string} lockfile
 * @returns {Array<Record<string, any>>}
 */
export function reportableAdvisories(report, lockfile) {
  try {
    evaluateAuditReport(
      report,
      { dir: lockfile, label: lockfile },
      { includeAdvisory: () => true },
    );
  } catch (error) {
    throw new Error(
      `pnpm audit failed for ${lockfile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const records = [];
  for (const advisory of Object.values(report.advisories ?? {})) {
    if (!isModeratePlusSeverity(advisory)) continue;
    for (const { finding, path } of findingPaths(advisory)) {
      if (
        isAllowedDiscordUndiciFinding(advisory, finding, path, {
          dir: lockfile,
          label: lockfile,
        })
      ) {
        continue;
      }
      records.push(advisoryRecord(advisory, finding, path, lockfile));
    }
  }
  return records;
}

/**
 * @param {Array<Record<string, any>>} records
 * @returns {Array<Record<string, any>>}
 */
export function dedupeAdvisories(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = `${record.id}:${record.module_name}:${record.path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.lockfiles.push(...record.lockfiles);
      existing.lockfiles = [...new Set(existing.lockfiles)].sort();
    } else {
      byKey.set(key, {
        ...record,
        lockfiles: [...record.lockfiles],
      });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const severityCompare = String(a.severity).localeCompare(
      String(b.severity),
    );
    if (severityCompare !== 0) return severityCompare;
    const moduleCompare = String(a.module_name).localeCompare(
      String(b.module_name),
    );
    if (moduleCompare !== 0) return moduleCompare;
    return String(a.path).localeCompare(String(b.path));
  });
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const { reports } = parseArgs(process.argv.slice(2));
  const records = reports.flatMap(({ label, path }) => {
    const report = parseAuditJson(readFileSync(path, "utf8"), label);
    return reportableAdvisories(report, label);
  });
  process.stdout.write(
    `${JSON.stringify(dedupeAdvisories(records), null, 2)}\n`,
  );
}
