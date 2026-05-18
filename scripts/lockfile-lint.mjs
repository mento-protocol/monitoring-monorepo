#!/usr/bin/env node
/**
 * Lockfile security validation for pnpm v9 YAML lockfiles.
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
 * No external dependencies — parses the lockfile with pure Node.js regex on
 * the known-structured pnpm v9 format.
 *
 * Run: `pnpm lockfile:lint`
 * CI: .github/workflows/supply-chain.yml
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

// Confirm lockfile version — only v9 is understood by this script.
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
      "Update the script if you upgraded pnpm.",
  );
  process.exit(1);
}

// Extract the `packages:` section (between "packages:\n" and "snapshots:\n" or EOF).
// In pnpm v9 the packages section lists every resolved package with its
// resolution block (integrity hash + optional engines/peerDependencies).
const packagesSectionStart = lockfileText.indexOf("\npackages:\n");
const snapshotsSectionStart = lockfileText.indexOf("\nsnapshots:\n");
const packagesSection =
  packagesSectionStart !== -1
    ? lockfileText.slice(
        packagesSectionStart + "\npackages:\n".length,
        snapshotsSectionStart !== -1 ? snapshotsSectionStart : undefined,
      )
    : "";

if (!packagesSection.trim()) {
  // An empty packages section is only valid for a completely empty monorepo.
  fail("pnpm-lock.yaml has an empty `packages:` section — unexpected.");
  process.exit(1);
}

// ── 2. Integrity validation ───────────────────────────────────────────────────
//
// Every top-level package entry looks like:
//
//   '@scope/name@version':            ← key at 2-space indent
//     resolution: {integrity: sha512-<base64>==}
//
// Packages resolved from `file:` or `link:` paths appear in `importers:`,
// not in `packages:`, so they are not subject to this check.

/** Regex to extract package name + version and its resolution integrity. */
const PKG_ENTRY =
  /^ {2}('?[^':\n]+@[^\n:']+?'?):\s*\n\s+resolution:\s*\{integrity:\s*(sha512-[A-Za-z0-9+/]+=*)\}/gm;

/** sha512 integrity: "sha512-" followed by base64 and "=" padding. */
const SHA512_RE = /^sha512-[A-Za-z0-9+/]{86,}={0,2}$/;

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

// Cross-check: total resolution: entries must equal entries with sha512.
// A missing integrity would not match PKG_ENTRY so we count separately.
const totalResolutions = (packagesSection.match(/^\s+resolution:/gm) ?? [])
  .length;

if (totalResolutions !== totalPackages) {
  const missing = totalResolutions - totalPackages;
  fail(
    `${missing} package(s) in pnpm-lock.yaml have a resolution block without a sha512 ` +
      "integrity hash. Run `pnpm install` with a known-good registry and re-inspect.",
  );
} else if (integrityErrors === 0) {
  ok(
    `All ${totalPackages} packages in pnpm-lock.yaml have valid sha512 integrity hashes.`,
  );
}

// ── 3. Registry source validation ────────────────────────────────────────────
//
// pnpm v9 no longer embeds resolved: URLs in the lockfile. The install-time
// registry is controlled by `.npmrc` + `pnpm-workspace.yaml`. We validate:
//   a) No `registry=` override in any .npmrc in this repo.
//   b) No `registries:` block in pnpm-workspace.yaml (custom registries).
//
// Workspace `link:` and `file:` protocol entries are fine — they are internal
// refs, not registry fetches.

const npmrcFiles = [
  ".npmrc",
  "indexer-envio/.npmrc",
  "ui-dashboard/.npmrc",
  "metrics-bridge/.npmrc",
  "shared-config/.npmrc",
];

let registryErrors = 0;

for (const rel of npmrcFiles) {
  const absPath = resolve(ROOT, rel);
  if (!existsSync(absPath)) continue;
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    // Skip comments and empty lines.
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Flag any `registry=` line that doesn't point to the official npm registry.
    if (/^registry\s*=/.test(trimmed)) {
      const val = trimmed.split("=").slice(1).join("=").trim();
      const canonical = "https://registry.npmjs.org";
      const isOfficial =
        val === canonical ||
        val === canonical + "/" ||
        val.startsWith("https://registry.npmjs.org/");
      if (!isOfficial) {
        fail(
          `${rel}:${i + 1} — non-npmjs registry detected: "${val}". ` +
            "All packages must resolve from https://registry.npmjs.org.",
        );
        registryErrors++;
      }
    }
    // Flag scope-specific registries (@scope:registry=...) pointing off-npmjs.
    if (/^@[^:]+:registry\s*=/.test(trimmed)) {
      const val = trimmed.split("=").slice(1).join("=").trim();
      if (!val.startsWith("https://registry.npmjs.org")) {
        fail(
          `${rel}:${i + 1} — scope-specific non-npmjs registry: "${trimmed}". ` +
            "If this is intentional, document why and add an exemption comment above this line.",
        );
        registryErrors++;
      }
    }
  }
}

// Check pnpm-workspace.yaml for registries: block.
const workspacePath = resolve(ROOT, "pnpm-workspace.yaml");
if (existsSync(workspacePath)) {
  const ws = readFileSync(workspacePath, "utf8");
  if (/^registries:/m.test(ws)) {
    fail(
      "pnpm-workspace.yaml contains a `registries:` block, which configures custom package " +
        "registries. Verify this is intentional and every non-npmjs registry entry is audited.",
    );
    registryErrors++;
  }
}

if (registryErrors === 0) {
  ok(
    "No custom registry overrides detected — all packages resolve from registry.npmjs.org.",
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode === 1) {
  console.error(
    "\n[31mlockfile-lint failed. Fix the issues above before merging.[0m",
  );
} else {
  console.log("\n[32mlockfile-lint passed.[0m");
}
