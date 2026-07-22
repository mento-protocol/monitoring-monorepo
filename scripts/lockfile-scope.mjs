#!/usr/bin/env node
/**
 * Structural classifier for pnpm-lock.yaml changes, used by
 * scripts/agent-quality-gate.sh to narrow the escalation a lockfile edit
 * triggers (GitHub issue #1414).
 *
 * Contract (fail toward the full suite):
 *   - Parses base and head lockfile YAML with js-yaml.
 *   - If ANY non-`importers` top-level section differs (settings, catalogs,
 *     overrides, patchedDependencies, packageExtensionsChecksum, packages,
 *     snapshots, lockfileVersion, …), the change is not scopable → "full".
 *   - Otherwise reports the importer keys whose section changed, so the gate
 *     can map each to its package quality bundle.
 *
 * CLI: `node scripts/lockfile-scope.mjs <base-lockfile> <head-lockfile>`
 *   - exit 0 and print each changed importer key on its own line when the
 *     change is scopable (an empty list means no semantic importer change).
 *   - exit 1 on any fail-toward-full condition, including read/parse errors.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jsYaml from "js-yaml";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Order-insensitive deep equality for parsed YAML documents.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * @param {unknown} base parsed base lockfile document
 * @param {unknown} head parsed head lockfile document
 * @returns {{ scope: "full" } | { scope: "importers", importers: string[] }}
 */
export function classifyLockfileChange(base, head) {
  if (!isRecord(base) || !isRecord(head)) return { scope: "full" };

  const topLevelKeys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of topLevelKeys) {
    if (key === "importers") continue;
    if (!deepEqual(base[key], head[key])) return { scope: "full" };
  }

  const baseImporters = isRecord(base.importers) ? base.importers : {};
  const headImporters = isRecord(head.importers) ? head.importers : {};
  const importerKeys = new Set([
    ...Object.keys(baseImporters),
    ...Object.keys(headImporters),
  ]);

  const changed = [];
  for (const key of [...importerKeys].sort()) {
    if (!deepEqual(baseImporters[key], headImporters[key])) changed.push(key);
  }

  return { scope: "importers", importers: changed };
}

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function main(argv) {
  const [basePath, headPath] = argv;
  if (!basePath || !headPath) {
    process.stderr.write(
      "usage: lockfile-scope.mjs <base-lockfile> <head-lockfile>\n",
    );
    return 1;
  }

  let base;
  let head;
  try {
    base = jsYaml.load(readFileSync(basePath, "utf8"));
    head = jsYaml.load(readFileSync(headPath, "utf8"));
  } catch {
    return 1;
  }

  const result = classifyLockfileChange(base, head);
  if (result.scope === "full") return 1;

  for (const importer of result.importers) {
    process.stdout.write(`${importer}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
