#!/usr/bin/env node
/**
 * Lockfile security validation for pnpm v9/v11 YAML lockfiles.
 *
 * lockfile-lint (the npm package) does not support pnpm lockfile v9 format —
 * v9 no longer embeds `resolved:` URLs in pnpm-lock.yaml, so the
 * "registry-URL poisoning" class of attacks must be validated differently:
 *
 *   1. Integrity gate: every package entry must have a `resolution.integrity`
 *      field with a valid sha512 hash. A missing or malformed hash means pnpm
 *      cannot verify the tarball content at install time.
 *
 *   2. Registry gate: the registry source of truth lives in `.npmrc` and
 *      `pnpm-workspace.yaml`, not in the lockfile. We validate that no custom
 *      registry is configured (i.e. all packages resolve from the default
 *      https://registry.npmjs.org).
 *
 *   3. Override floor gate: `pnpm.overrides` / `resolutions` ranges in
 *      package.json and every pnpm-workspace.yaml must not use unbounded
 *      minimum ranges.
 *
 * No external dependencies — parses the lockfile with pure Node.js regex on
 * the known-structured pnpm lockfile format.
 *
 * This file owns gates 1 and 2 and the summary. Gate 3 lives in
 * lockfile-lint-registry-sources.mjs and gate 4 in
 * lockfile-lint-override-ranges.mjs — they read different inputs (config files
 * versus override maps) and share only the pnpm-workspace.yaml walk, which the
 * registry pass returns.
 *
 * Run: `pnpm lockfile:lint`
 * CI: .github/workflows/supply-chain.yml
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateOverrideRanges } from "./lockfile-lint-override-ranges.mjs";
import { validateRegistrySources } from "./lockfile-lint-registry-sources.mjs";

// ROOT defaults to cwd so the script works from any worktree root without
// path-hardcoding. Tests override via LOCKFILE_LINT_ROOT env var so they can
// point at a synthetic temp directory without relocating the script file.
const ROOT = process.env["LOCKFILE_LINT_ROOT"] ?? process.cwd();

// ── helpers ──────────────────────────────────────────────────────────────────

/** @param {string} msg */
function fail(msg) {
  console.error(`[31m✖ ${msg}[0m`);
  process.exitCode = 1;
}

/** @param {string} msg */
function ok(msg) {
  console.log(`[32m✔ ${msg}[0m`);
}

// ── 1. Parse lockfile ─────────────────────────────────────────────────────────

const lockfilePath = resolve(ROOT, "pnpm-lock.yaml");
if (!existsSync(lockfilePath)) {
  fail(`pnpm-lock.yaml not found at ${lockfilePath}`);
  process.exit(1);
}

const lockfileText = readFileSync(lockfilePath, "utf8");

// Confirm lockfile version — only v9 is understood by this script. pnpm 11
// still writes lockfileVersion 9.x for this workspace.
const versionMatch = lockfileText.match(
  /^lockfileVersion:\s*['"]?(\S+?)['"]?\s*$/m,
);
if (!versionMatch) {
  fail("Could not determine lockfile version from pnpm-lock.yaml");
  process.exit(1);
}
const lockfileVersion = versionMatch[1];
if (!lockfileVersion.startsWith("9")) {
  fail(
    `Unexpected lockfile version "${lockfileVersion}" — this script targets pnpm v9.x. ` +
      "Update the script if pnpm's lockfile schema changes.",
  );
  process.exit(1);
}

function selectPackageGraphDocument(text) {
  const documents = text.split(/^---\s*$/m);
  return (
    documents.find(
      (document) =>
        /^packages:\s*$/m.test(document) && /^snapshots:\s*$/m.test(document),
    ) ?? text
  );
}

function topLevelHeaderIndex(text, header) {
  const match = new RegExp(`^${header}:\\s*$`, "m").exec(text);
  return match ? { index: match.index, length: match[0].length } : null;
}

const packageGraphDocument = selectPackageGraphDocument(lockfileText);

// Extract the `packages:` section (between top-level `packages:` and
// `snapshots:` or EOF). pnpm 11 may write leading metadata as a separate YAML
// document; parse the document containing the package graph, not just the first
// `packages:` string in the file.
const packagesSectionStart = topLevelHeaderIndex(
  packageGraphDocument,
  "packages",
);
const snapshotsSectionStart = topLevelHeaderIndex(
  packageGraphDocument,
  "snapshots",
);
const packagesSection =
  packagesSectionStart !== null
    ? packageGraphDocument.slice(
        packagesSectionStart.index + packagesSectionStart.length,
        snapshotsSectionStart !== null &&
          snapshotsSectionStart.index > packagesSectionStart.index
          ? snapshotsSectionStart.index
          : undefined,
      )
    : "";

if (!packagesSection.trim()) {
  // An empty packages section is only valid for a completely empty monorepo.
  fail("pnpm-lock.yaml has an empty `packages:` section — unexpected.");
  process.exit(1);
}

// ── 2. Integrity validation ───────────────────────────────────────────────────
//
// Every registry-tarball top-level package entry looks like:
//
//   '@scope/name@version':            ← key at 2-space indent
//     resolution: {integrity: sha512-<base64>==}
//
// pnpm v9 also writes local file/directory dependencies under `packages:`,
// keyed as `<name>@file:<path>` with `resolution: {directory: ..., type: directory}`.
// Those entries don't carry an integrity hash (they're not registry tarballs)
// and must be exempted from the integrity check.

/** Regex to extract a registry-tarball package entry + its sha512 integrity. */
const PKG_ENTRY =
  /^ {2}('?[^':\n]+@[^\n:']+?'?):\s*\n\s+resolution:\s*\{integrity:\s*(sha512-[A-Za-z0-9+/]+=*)\}/gm;

/**
 * Regex to identify TRULY LOCAL entries (`file:` / `link:` only) that
 * legitimately have no integrity hash. Remote git protocols (`git+ssh:`,
 * `git+https:`, `github:`) are NOT exempted — pnpm v9 stores integrity
 * for those too, and treating them as local would let a PR add an
 * unaudited remote git dep that bypasses the registry gate.
 */
const LOCAL_SOURCE_ENTRY =
  /^ {2}('[^':\n]+@(?:file|link):[^\n']+'|[^':\n]+@(?:file|link):[^\n:']+):/gm;

/**
 * sha512 integrity. SHA-512 = 64 raw bytes = exactly 88 base64 chars total
 * (86 data chars + 2 `=` padding). The previous `{86,}={0,2}` upper-bound
 * was unbounded, accepting malformed SRI like 100-char base64 strings that
 * would later fail at frozen-install time. Lock to the SHA-512 canonical
 * shape so the gate rejects malformed integrity at PR time.
 */
const SHA512_RE = /^sha512-[A-Za-z0-9+/]{86}={2}$/;

let totalPackages = 0;
let integrityErrors = 0;

/** @type {RegExpExecArray | null} */
let match;

while ((match = PKG_ENTRY.exec(packagesSection)) !== null) {
  totalPackages++;
  const name = match[1];
  const integrity = match[2];
  if (!SHA512_RE.test(integrity)) {
    fail(`Invalid integrity hash for ${name}: "${integrity}"`);
    integrityErrors++;
  }
}

// Cross-check #1: every entry with a `resolution:` block must carry a sha512.
// A `resolution:` line that's not followed by `{integrity: sha512-...}` won't
// match PKG_ENTRY, so we count `resolution:` lines and compare.
const totalResolutions = (packagesSection.match(/^\s+resolution:/gm) ?? [])
  .length;

// Cross-check #2: every top-level package entry must have either a sha512
// integrity (registry tarball) OR be a local-source entry (file:/link:/git+).
// Without this an entry whose `resolution:` line was stripped entirely would
// slip past the integrity counter and the bare-resolution counter alike.
// Match any EXACTLY-2-space-indented YAML key ending in `:` at end-of-line.
// Sub-keys (`resolution:`, `engines:`, etc.) and dependency name keys live
// at 4+ space indent so don't match. The `[^':\n ]` after `^ {2}` rejects
// further whitespace, anchoring at exactly the 2-indent level (the old
// `[^':\n]` accidentally accepted a space → matched 4/6/8-space deeper
// keys whose first char happened to be space). The `\s*$` anchor lets
// the key spec contain embedded `:` characters (e.g. `name@git+file://path:`)
// — only the terminator `:` must sit at line end.
const totalEntries = (
  packagesSection.match(
    /^ {2}('[^':\n]+@[^\n']+'|[^':\n ][^:\n]*@[^\n]+?):\s*$/gm,
  ) ?? []
).length;

// Count local-source entries so the discrepancy check doesn't false-positive
// on legitimate `file:` / `link:` / git deps that don't carry sha512 hashes.
const totalLocalSources = (packagesSection.match(LOCAL_SOURCE_ENTRY) ?? [])
  .length;
const expectedRegistryEntries = totalEntries - totalLocalSources;

// Sanity floor: if the regex matched zero top-level entries against a
// non-empty `packages:` section, the regex is out of sync with the
// lockfile format (e.g., a future pnpm v9.x point-release that changes
// the on-disk shape) and the gate would silently pass with "All 0
// packages have valid sha512". Fail loudly instead so the script is
// updated, not bypassed.
if (totalEntries === 0) {
  fail(
    "pnpm-lock.yaml `packages:` section is non-empty but no top-level package " +
      "entries matched the parser. The lockfile-lint regex is likely out of sync " +
      "with pnpm v9's on-disk format. Inspect `scripts/supply-chain/lockfile-lint.mjs` and " +
      "update PKG_ENTRY / LOCAL_SOURCE_ENTRY / totalEntries patterns to match.",
  );
  process.exit(1);
}

if (expectedRegistryEntries !== totalPackages) {
  const missingResolution =
    expectedRegistryEntries - (totalResolutions - totalLocalSources);
  const missingIntegrity = totalResolutions - totalLocalSources - totalPackages;
  if (missingResolution > 0) {
    fail(
      `${missingResolution} package entry/entries in pnpm-lock.yaml have NO resolution block. ` +
        "Re-run `pnpm install` from a known-good registry and re-inspect.",
    );
  }
  if (missingIntegrity > 0) {
    fail(
      `${missingIntegrity} package(s) in pnpm-lock.yaml have a resolution block without a sha512 ` +
        "integrity hash. Re-run `pnpm install` from a known-good registry and re-inspect.",
    );
  }
} else if (integrityErrors === 0) {
  const localNote =
    totalLocalSources > 0
      ? ` (${totalLocalSources} local file:/link:/git deps exempted from the integrity check)`
      : "";
  ok(
    `All ${totalPackages} registry-tarball packages in pnpm-lock.yaml have valid sha512 integrity hashes${localNote}.`,
  );
}

// ── 3. Registry source validation ────────────────────────────────────────────

const { workspaceFiles } = validateRegistrySources({ root: ROOT, fail, ok });

// ── 4. pnpm override range validation ────────────────────────────────────────
//
// Reuses the pnpm-workspace.yaml walk from the registry pass above, so the
// tree is scanned once.

validateOverrideRanges({ root: ROOT, workspaceFiles, fail, ok });

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode === 1) {
  console.error(
    "\n[31mlockfile-lint failed. Fix the issues above before merging.[0m",
  );
} else {
  console.log("\n[32mlockfile-lint passed.[0m");
}
