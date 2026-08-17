/**
 * Registry-source validation for `pnpm lockfile:lint`.
 *
 * pnpm v9 no longer embeds resolved: URLs in the lockfile. The install-time
 * registry is controlled by `.npmrc` + `pnpm-workspace.yaml`. This module
 * validates:
 *   a) No `registry=` override in any .npmrc in this repo.
 *   b) No `registries:` block in pnpm-workspace.yaml (custom registries).
 *
 * Workspace `link:` and `file:` protocol entries are fine — they are internal
 * refs, not registry fetches.
 *
 * The directory walk that finds every `pnpm-workspace.yaml` also feeds the
 * override-range gate, so `validateRegistrySources` returns the list rather
 * than making the caller walk the tree twice.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Strip optional surrounding quotes from an npmrc/yaml key. pnpm accepts
 * `"registry"=...` and `'registry'=...` as equivalent to bare `registry=`,
 * so we normalize the left-hand side before matching. Shared with
 * lockfile-lint-override-ranges.mjs, which normalizes YAML map keys the same
 * way.
 * @param {string} key
 */
export function unquote(key) {
  return key.replace(/^['"]|['"]$/g, "");
}

// Walk the repo for every `.npmrc` (excluding `.git/`, `.claude/`, and `node_modules/`)
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
    if (
      entry.name === ".git" ||
      entry.name === ".claude" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
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
    if (
      entry.name === ".git" ||
      entry.name === ".claude" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
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

/**
 * @param {{
 *   root: string;
 *   fail: (msg: string) => void;
 *   ok: (msg: string) => void;
 * }} options
 * @returns {{ errors: number; workspaceFiles: string[] }}
 */
export function validateRegistrySources({ root, fail, ok }) {
  /** @type {string[]} */
  const npmrcFiles = [];
  findNpmrcs(root, npmrcFiles);

  let registryErrors = 0;

  for (const absPath of npmrcFiles) {
    const rel = relative(root, absPath);
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

  /** @type {string[]} */
  const workspaceFiles = [];
  findPnpmWorkspaces(root, workspaceFiles);

  // Check every pnpm-workspace.yaml for BOTH the singular `registry:` top-level
  // key (default registry override; `pnpm config get registry --location project`
  // resolves it) AND the plural `registries:` block (scoped overrides). Either
  // can redirect installs away from npmjs.org.
  for (const absPath of workspaceFiles) {
    const rel = relative(root, absPath);
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

  return { errors: registryErrors, workspaceFiles };
}
