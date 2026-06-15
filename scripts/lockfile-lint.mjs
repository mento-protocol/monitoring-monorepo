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
 *   3. Override floor gate: `pnpm.overrides` / `resolutions` ranges in
 *      package.json and every pnpm-workspace.yaml must not use unbounded
 *      minimum ranges.
 *
 * No external dependencies — parses the lockfile with pure Node.js regex on
 * the known-structured pnpm v9 format.
 *
 * Run: `pnpm lockfile:lint`
 * CI: .github/workflows/supply-chain.yml
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

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
      "with pnpm v9's on-disk format. Inspect `scripts/lockfile-lint.mjs` and " +
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
//
// pnpm v9 no longer embeds resolved: URLs in the lockfile. The install-time
// registry is controlled by `.npmrc` + `pnpm-workspace.yaml`. We validate:
//   a) No `registry=` override in any .npmrc in this repo.
//   b) No `registries:` block in pnpm-workspace.yaml (custom registries).
//
// Workspace `link:` and `file:` protocol entries are fine — they are internal
// refs, not registry fetches.

// Walk the repo for every `.npmrc` (excluding `.git/` and `node_modules/`)
// — pnpm reads `.npmrc` from every package directory it finds, so a future
// workspace adding its own `.npmrc` with `registry=...` would silently
// bypass a fixed allowlist.
/**
 * @param {string} dir
 * @param {string[]} out
 */
function findNpmrcs(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findNpmrcs(full, out);
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name === ".npmrc"
    ) {
      // Include symlinks — pnpm follows them at install time, so a `.npmrc`
      // pointing to a malicious file via symlink would bypass the gate
      // unless we read the resolved target.
      out.push(full);
    }
  }
}

/** @type {string[]} */
const npmrcFiles = [];
findNpmrcs(ROOT, npmrcFiles);

/**
 * Registry-host check is exact-canonical (NOT prefix-based) so an attacker
 * cannot bypass with a lookalike host like
 * `https://registry.npmjs.org.evil.com/` — that string starts with
 * "https://registry.npmjs.org" but is a different host.
 * @param {string} val
 */
function isOfficialNpmRegistry(val) {
  const canonical = "https://registry.npmjs.org";
  return (
    val === canonical ||
    val === canonical + "/" ||
    val.startsWith(canonical + "/")
  );
}

let registryErrors = 0;

/**
 * Strip optional surrounding quotes from an npmrc/yaml key. pnpm accepts
 * `"registry"=...` and `'registry'=...` as equivalent to bare `registry=`,
 * so we normalize the left-hand side before matching.
 * @param {string} key
 */
function unquote(key) {
  return key.replace(/^['"]|['"]$/g, "");
}

for (const absPath of npmrcFiles) {
  const rel = relative(ROOT, absPath);
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    // Skip comments and empty lines.
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Reject userconfig / globalconfig indirection: those directives make
    // pnpm read a SECOND config file whose contents could carry the
    // attacker's `registry=...`. Detecting and rejecting them outright is
    // simpler (and safer) than recursively resolving + scanning every
    // possible target.
    if (/^['"]?(userconfig|globalconfig)['"]?\s*=/.test(trimmed)) {
      fail(
        `${rel}:${i + 1} — npmrc directive forbidden: "${trimmed}". ` +
          "pnpm follows `userconfig=` / `globalconfig=` to a second config " +
          "file, which can carry an attacker-controlled `registry=` line " +
          "and bypass this check. Inline any required config in the same " +
          ".npmrc instead.",
      );
      registryErrors++;
      continue;
    }
    // Split on `=` and normalize the key half so `"registry"=` and
    // `'registry'=` parse the same as `registry=`.
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const rawKey = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    const key = unquote(rawKey);
    // Flag any `registry=` line that doesn't point to the official npm registry.
    if (key === "registry") {
      if (!isOfficialNpmRegistry(val)) {
        fail(
          `${rel}:${i + 1} — non-npmjs registry detected: "${val}". ` +
            "All packages must resolve from https://registry.npmjs.org.",
        );
        registryErrors++;
      }
      continue;
    }
    // Scope-specific registries: key looks like `@scope:registry` (possibly
    // quoted as `"@scope:registry"`). Use the SAME exact-canonical check.
    if (/^@[^:]+:registry$/.test(key)) {
      if (!isOfficialNpmRegistry(val)) {
        fail(
          `${rel}:${i + 1} — scope-specific non-npmjs registry: "${trimmed}". ` +
            "If this is intentional, document why and add an exemption comment above this line.",
        );
        registryErrors++;
      }
    }
  }
}

/**
 * @param {string} dir
 * @param {string[]} out
 */
function findPnpmWorkspaces(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findPnpmWorkspaces(full, out);
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name === "pnpm-workspace.yaml"
    ) {
      out.push(full);
    }
  }
}

/** @type {string[]} */
const workspaceFiles = [];
findPnpmWorkspaces(ROOT, workspaceFiles);

// Check every pnpm-workspace.yaml for BOTH the singular `registry:` top-level
// key (default registry override; `pnpm config get registry --location project`
// resolves it) AND the plural `registries:` block (scoped overrides). Either
// can redirect installs away from npmjs.org.
for (const absPath of workspaceFiles) {
  const rel = relative(ROOT, absPath);
  const ws = readFileSync(absPath, "utf8");
  const lines = ws.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Top-level `registry: <url>` key. Accept quoted variants too (YAML
    // allows `'registry':` or `"registry":` as equivalent), since pnpm
    // resolves all three to the same key.
    const singularMatch = /^['"]?(registry)['"]?\s*:\s*(.+?)\s*$/.exec(line);
    if (singularMatch && /^\s/.test(line) === false) {
      // Require the key to start at column 0 (top-level YAML scalar).
      const raw = unquote(singularMatch[2].trim());
      if (!isOfficialNpmRegistry(raw)) {
        fail(
          `${rel}:${i + 1} — non-npmjs default registry: "${raw}". ` +
            "All packages must resolve from https://registry.npmjs.org.",
        );
        registryErrors++;
      }
    }
    // Plural `registries:` mapping — quoted or unquoted.
    if (
      /^['"]?registries['"]?\s*:/.test(trimmed) &&
      /^\s/.test(line) === false
    ) {
      fail(
        `${rel}:${i + 1} — \`registries:\` block configures custom package ` +
          "registries. Verify this is intentional and every non-npmjs registry entry is audited.",
      );
      registryErrors++;
    }
  }
}

if (registryErrors === 0) {
  ok(
    "No custom registry overrides detected — all packages resolve from registry.npmjs.org.",
  );
}

// ── 4. pnpm override range validation ────────────────────────────────────────
//
// Root `pnpm.overrides` selector ranges or values like `">=1.2.3"` are
// install-time floors, not persistent pins. On a fresh lockfile resolve, they
// can pull in the newest future major for the whole graph. Allow bounded
// selector keys (`pkg@>=1 <2`) and same-major/capped values, but reject
// unbounded minimum ranges.

/**
 * @param {string} value
 */
function isUnboundedMinimumOverrideValue(value) {
  const branches = value
    .trim()
    .split(/\s*\|\|\s*/)
    .filter(Boolean);
  return branches.some(
    (branch) =>
      /(?:^|\s)v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?\s+-\s*(?:[*xX](?:\.[*xX]){0,2})(?:\s|$)/.test(
        branch,
      ) ||
      (/(?:^|\s)=?>=?\s*v?\d/i.test(branch) &&
        !/(?:^|\s)<[=]?\s*v?\d/i.test(branch)),
  );
}

/**
 * @param {string} selector
 * @param {number} index
 */
function isPeerSelectorSeparator(selector, index) {
  const previous = selector[index - 1] ?? "";
  const next = selector[index + 1] ?? "";
  return (
    next !== "" &&
    next !== "=" &&
    previous !== "@" &&
    previous !== "<" &&
    previous !== ">" &&
    previous !== "=" &&
    !/\s|\|/.test(previous)
  );
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
function peerQualifiedSelectorParts(selector) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] === ">" && isPeerSelectorSeparator(selector, index)) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

/**
 * @param {string} selector
 */
function overrideSelectorRanges(selector) {
  return peerQualifiedSelectorParts(selector)
    .map((packageSelector) => {
      const rangeSeparator = packageSelector.indexOf("@", 1);
      if (rangeSeparator === -1) return null;
      return packageSelector.slice(rangeSeparator + 1).trim() || null;
    })
    .filter((range) => range !== null);
}

/**
 * @param {string} value
 */
function stripYamlInlineComment(value) {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

/**
 * @param {string} text
 * @returns {{ key: string; value: string } | null}
 */
function splitYamlMapEntry(text) {
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ":") {
      return {
        key: text.slice(0, index).trim(),
        value: text.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

/**
 * @param {string} text
 */
function splitYamlInlineMapItems(text) {
  const items = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
      continue;
    }
    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items.filter(Boolean);
}

/**
 * @param {string} value
 */
function stripYamlAnchor(value) {
  const trimmed = value
    .trim()
    .replace(/^![^\s]+\s+/, "")
    .trim();
  const match = /^&[A-Za-z0-9_-]+(?:\s+(.*))?$/.exec(trimmed);
  return match ? (match[1] ?? "").trim() : trimmed;
}

/**
 * @param {string} value
 * @param {number} line
 * @returns {Array<{ selector: string; replacement: string; line: number }>}
 */
function extractInlineWorkspaceMapEntries(value, line) {
  const trimmed = stripYamlInlineComment(value);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return [];
  }
  return splitYamlInlineMapItems(trimmed.slice(1, -1))
    .map((item) => {
      const entry = splitYamlMapEntry(item);
      if (!entry) return null;
      const selector = unquote(entry.key);
      const replacement = unquote(
        stripYamlAnchor(stripYamlInlineComment(entry.value)),
      );
      return selector && replacement ? { selector, replacement, line } : null;
    })
    .filter((entry) => entry !== null);
}

/**
 * @param {string} absPath
 * @param {string} mapName
 * @returns {Array<{ selector: string; replacement: string; line: number }>}
 */
function extractWorkspaceMapEntries(absPath, mapName) {
  const content = readFileSync(absPath, "utf8");
  const mapEntries = [];
  const mapHeader = new RegExp(`^['"]?${mapName}['"]?\\s*:\\s*(.*)$`);
  let inTargetMap = false;

  for (const [i, rawLine] of content.split("\n").entries()) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\S/.test(line)) {
      const mapMatch = mapHeader.exec(trimmed);
      if (mapMatch) {
        const inlineValue = stripYamlAnchor(
          stripYamlInlineComment(mapMatch[1]),
        );
        if (!inlineValue) {
          inTargetMap = true;
        } else if (inlineValue.startsWith("{") && inlineValue.endsWith("}")) {
          mapEntries.push(
            ...extractInlineWorkspaceMapEntries(inlineValue, i + 1),
          );
          inTargetMap = false;
        } else {
          inTargetMap = false;
        }
      } else {
        inTargetMap = false;
      }
      continue;
    }
    if (!inTargetMap) continue;

    const entry = splitYamlMapEntry(trimmed);
    if (!entry) continue;

    const selector = unquote(entry.key);
    const replacement = unquote(
      stripYamlAnchor(stripYamlInlineComment(entry.value)),
    );
    if (selector && replacement) {
      mapEntries.push({ selector, replacement, line: i + 1 });
    }
  }

  return mapEntries;
}

/**
 * @param {string} absPath
 * @returns {Array<{ selector: string; replacement: string; line: number }>}
 */
function extractWorkspaceOverrides(absPath) {
  return extractWorkspaceMapEntries(absPath, "overrides");
}

/**
 * @param {string} absPath
 */
function extractWorkspaceCatalog(absPath) {
  return new Map(
    extractWorkspaceMapEntries(absPath, "catalog").map(
      ({ selector, replacement }) => [selector, replacement],
    ),
  );
}

/**
 * @param {Map<string, Map<string, string>>} catalogs
 * @param {string} name
 * @param {Array<{ selector: string; replacement: string }>} entries
 */
function addNamedCatalogEntries(catalogs, name, entries) {
  let catalog = catalogs.get(name);
  if (!catalog) {
    catalog = new Map();
    catalogs.set(name, catalog);
  }
  for (const { selector, replacement } of entries) {
    catalog.set(selector, replacement);
  }
}

/**
 * @param {string} value
 * @returns {Map<string, Map<string, string>>}
 */
function extractInlineWorkspaceNamedCatalogs(value) {
  const named = new Map();
  const trimmed = stripYamlInlineComment(value);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return named;
  }
  for (const item of splitYamlInlineMapItems(trimmed.slice(1, -1))) {
    const entry = splitYamlMapEntry(item);
    if (!entry) continue;
    const name = unquote(entry.key);
    const catalogValue = stripYamlAnchor(stripYamlInlineComment(entry.value));
    if (!name || !catalogValue) continue;
    addNamedCatalogEntries(
      named,
      name,
      extractInlineWorkspaceMapEntries(catalogValue, 0),
    );
  }
  return named;
}

/**
 * @param {string} absPath
 * @returns {Map<string, Map<string, string>>}
 */
function extractWorkspaceNamedCatalogs(absPath) {
  const content = readFileSync(absPath, "utf8");
  const named = new Map();
  const catalogsHeader = /^['"]?catalogs['"]?\s*:\s*(.*)$/;
  let inCatalogs = false;
  let currentCatalog = "";
  let currentCatalogIndent = 0;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\S/.test(line)) {
      const catalogsMatch = catalogsHeader.exec(trimmed);
      if (catalogsMatch) {
        const inlineValue = stripYamlAnchor(
          stripYamlInlineComment(catalogsMatch[1]),
        );
        if (!inlineValue) {
          inCatalogs = true;
          currentCatalog = "";
        } else if (inlineValue.startsWith("{") && inlineValue.endsWith("}")) {
          for (const [name, catalog] of extractInlineWorkspaceNamedCatalogs(
            inlineValue,
          )) {
            addNamedCatalogEntries(
              named,
              name,
              Array.from(catalog, ([selector, replacement]) => ({
                selector,
                replacement,
              })),
            );
          }
          inCatalogs = false;
        } else {
          inCatalogs = false;
        }
      } else {
        inCatalogs = false;
      }
      continue;
    }
    if (!inCatalogs) continue;

    const indent = line.length - line.trimStart().length;
    const entry = splitYamlMapEntry(trimmed);
    if (!entry) continue;

    const value = stripYamlAnchor(stripYamlInlineComment(entry.value));
    if (!currentCatalog || indent <= currentCatalogIndent) {
      const name = unquote(entry.key);
      if (!name) {
        currentCatalog = "";
        continue;
      }
      if (!value) {
        currentCatalog = name;
        currentCatalogIndent = indent;
        addNamedCatalogEntries(named, currentCatalog, []);
      } else if (value.startsWith("{") && value.endsWith("}")) {
        addNamedCatalogEntries(
          named,
          name,
          extractInlineWorkspaceMapEntries(value, 0),
        );
        currentCatalog = "";
      } else {
        currentCatalog = "";
      }
      continue;
    }

    const selector = unquote(entry.key);
    const replacement = unquote(value);
    if (selector && replacement) {
      addNamedCatalogEntries(named, currentCatalog, [
        { selector, replacement },
      ]);
    }
  }

  return named;
}

/**
 * @param {string} absPath
 */
function extractWorkspaceCatalogs(absPath) {
  return {
    default: extractWorkspaceCatalog(absPath),
    named: extractWorkspaceNamedCatalogs(absPath),
  };
}

/**
 * @param {string} selector
 */
function packageNameFromOverrideSelector(selector) {
  const parts = peerQualifiedSelectorParts(selector);
  const packageSelector = parts[parts.length - 1] ?? selector;
  const rangeSeparator = packageSelector.indexOf("@", 1);
  return rangeSeparator === -1
    ? packageSelector
    : packageSelector.slice(0, rangeSeparator);
}

/**
 * @param {string} value
 */
function npmAliasRange(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("npm:")) return null;
  const spec = trimmed.slice("npm:".length);
  const rangeSeparator = spec.startsWith("@")
    ? spec.indexOf("@", spec.indexOf("/") + 1)
    : spec.indexOf("@");
  if (rangeSeparator === -1) return null;
  return spec.slice(rangeSeparator + 1).trim() || null;
}

/**
 * @param {string} value
 */
function isYamlAliasOverrideValue(value) {
  return /^\*[A-Za-z0-9_-]+$/.test(value.trim());
}

/**
 * @param {string} value
 */
function isUnresolvedCatalogOverrideValue(value) {
  return /^catalog:(?:[A-Za-z0-9._-]+)?$/.test(value.trim());
}

/**
 * @param {string} selector
 * @param {unknown} replacement
 * @param {{ default: Map<string, string>; named: Map<string, Map<string, string>> }} catalogs
 */
function effectiveOverrideReplacement(selector, replacement, catalogs) {
  if (typeof replacement !== "string") return replacement;
  const catalogMatch = /^catalog:(.*)$/.exec(replacement.trim());
  if (!catalogMatch) return replacement;
  const packageName = packageNameFromOverrideSelector(selector);
  const catalogName = catalogMatch[1].trim();
  const catalog = catalogName
    ? catalogs.named.get(catalogName)
    : catalogs.default;
  return catalog?.get(packageName) ?? replacement;
}

/**
 * @param {string} source
 * @param {string} selector
 * @param {unknown} replacement
 */
function validatePnpmOverrideEntry(source, selector, replacement) {
  let errors = 0;
  for (const selectorRange of overrideSelectorRanges(selector)) {
    if (isUnboundedMinimumOverrideValue(selectorRange)) {
      fail(
        `${source} selector "${selector}" uses ` +
          `unbounded minimum range "${selectorRange}". Use a bounded ` +
          "selector range before pinning the replacement.",
      );
      errors++;
    }
  }
  if (typeof replacement === "string") {
    if (isUnresolvedCatalogOverrideValue(replacement)) {
      fail(
        `${source}["${selector}"] uses unresolved catalog override ` +
          `"${replacement}". Add a matching catalog entry for the package or ` +
          "inline the replacement range.",
      );
      errors++;
      return errors;
    }
    if (isYamlAliasOverrideValue(replacement)) {
      fail(
        `${source}["${selector}"] uses YAML alias "${replacement}". Inline ` +
          "the override replacement so lockfile:lint can validate the resolved range.",
      );
      errors++;
      return errors;
    }
    const replacementRanges = [replacement];
    const aliasRange = npmAliasRange(replacement);
    if (aliasRange) replacementRanges.push(aliasRange);
    for (const replacementRange of replacementRanges) {
      if (isUnboundedMinimumOverrideValue(replacementRange)) {
        fail(
          `${source}["${selector}"] uses unbounded minimum ` +
            `range "${replacementRange}". Use a bounded selector with an exact ` +
            "replacement or a same-major/capped replacement range.",
        );
        errors++;
      }
    }
  }
  return errors;
}

const packageJsonPath = resolve(ROOT, "package.json");
const rootWorkspacePath = resolve(ROOT, "pnpm-workspace.yaml");
const rootCatalogs = existsSync(rootWorkspacePath)
  ? extractWorkspaceCatalogs(rootWorkspacePath)
  : { default: new Map(), named: new Map() };
let overrideRangeErrors = 0;

if (existsSync(packageJsonPath)) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail(
      `package.json could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    overrideRangeErrors++;
  }

  const overrides = packageJson?.pnpm?.overrides;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [selector, replacement] of Object.entries(overrides)) {
      overrideRangeErrors += validatePnpmOverrideEntry(
        "package.json pnpm.overrides",
        selector,
        effectiveOverrideReplacement(selector, replacement, rootCatalogs),
      );
    }
  }

  if (
    packageJson?.resolutions &&
    typeof packageJson.resolutions === "object" &&
    !Array.isArray(packageJson.resolutions)
  ) {
    for (const [selector, replacement] of Object.entries(
      packageJson.resolutions,
    )) {
      overrideRangeErrors += validatePnpmOverrideEntry(
        "package.json resolutions",
        selector,
        effectiveOverrideReplacement(selector, replacement, rootCatalogs),
      );
    }
  }
}

for (const absPath of workspaceFiles) {
  const rel = relative(ROOT, absPath);
  const catalogs = extractWorkspaceCatalogs(absPath);
  for (const { selector, replacement, line } of extractWorkspaceOverrides(
    absPath,
  )) {
    overrideRangeErrors += validatePnpmOverrideEntry(
      `${rel}:${line} overrides`,
      selector,
      effectiveOverrideReplacement(selector, replacement, catalogs),
    );
  }
}

if (overrideRangeErrors === 0) {
  ok("No unbounded minimum pnpm override/resolution values detected.");
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode === 1) {
  console.error(
    "\n[31mlockfile-lint failed. Fix the issues above before merging.[0m",
  );
} else {
  console.log("\n[32mlockfile-lint passed.[0m");
}
