/**
 * Override-range validation for `pnpm lockfile:lint`.
 *
 * Root `pnpm.overrides` selector ranges or values like `">=1.2.3"` are
 * install-time floors, not persistent pins. On a fresh lockfile resolve, they
 * can pull in the newest future major for the whole graph. This module allows
 * bounded selector keys (`pkg@>=1 <2`) and same-major/capped values, but
 * rejects unbounded minimum ranges.
 *
 * Selector parsing (the bare-`>` path separator versus a `>`/`>=` range
 * comparator) lives in scripts/lib/pnpm-override-selector.mjs, shared with
 * scripts/supply-chain/override-prune-report.mjs. That advisory never fails
 * anything and this gate always can, so a divergent second copy would let the
 * two disagree about the same syntax with nothing going red.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  packageNameFromOverrideSelector,
  peerQualifiedSelectorParts,
} from "../lib/pnpm-override-selector.mjs";
import { unquote } from "./lockfile-lint-registry-sources.mjs";

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
          mapEntries.push({
            selector: `${mapName} map`,
            replacement: inlineValue,
            line: i + 1,
          });
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
function isYamlBlockScalarOverrideValue(value) {
  return /^[>|][-+]?$/.test(value.trim());
}

/**
 * @param {string} value
 */
function isUnresolvedCatalogOverrideValue(value) {
  return /^catalog:(?:[A-Za-z0-9._-]+)?$/.test(value.trim());
}

/**
 * @param {string} value
 */
function isPnpmOverrideReferenceValue(value) {
  return /^\$[A-Za-z0-9._@/-]+$/.test(value.trim());
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
 * @param {(msg: string) => void} fail
 * @param {string} source
 * @param {string} selector
 * @param {unknown} replacement
 */
function validatePnpmOverrideEntry(fail, source, selector, replacement) {
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
    if (isPnpmOverrideReferenceValue(replacement)) {
      fail(
        `${source}["${selector}"] uses pnpm override reference ` +
          `"${replacement}". Inline the referenced spec so lockfile:lint can ` +
          "validate the resolved range.",
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
    if (isYamlBlockScalarOverrideValue(replacement)) {
      fail(
        `${source}["${selector}"] uses YAML block scalar "${replacement}". ` +
          "Inline the override replacement so lockfile:lint can validate the resolved range.",
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

/**
 * @param {{
 *   root: string;
 *   workspaceFiles: string[];
 *   fail: (msg: string) => void;
 *   ok: (msg: string) => void;
 * }} options
 * @returns {number}
 */
export function validateOverrideRanges({ root, workspaceFiles, fail, ok }) {
  const packageJsonPath = resolve(root, "package.json");
  const rootWorkspacePath = resolve(root, "pnpm-workspace.yaml");
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
    if (
      overrides &&
      typeof overrides === "object" &&
      !Array.isArray(overrides)
    ) {
      for (const [selector, replacement] of Object.entries(overrides)) {
        overrideRangeErrors += validatePnpmOverrideEntry(
          fail,
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
          fail,
          "package.json resolutions",
          selector,
          effectiveOverrideReplacement(selector, replacement, rootCatalogs),
        );
      }
    }
  }

  for (const absPath of workspaceFiles) {
    const rel = relative(root, absPath);
    const catalogs = extractWorkspaceCatalogs(absPath);
    for (const { selector, replacement, line } of extractWorkspaceOverrides(
      absPath,
    )) {
      overrideRangeErrors += validatePnpmOverrideEntry(
        fail,
        `${rel}:${line} overrides`,
        selector,
        effectiveOverrideReplacement(selector, replacement, catalogs),
      );
    }
  }

  if (overrideRangeErrors === 0) {
    ok("No unbounded minimum pnpm override/resolution values detected.");
  }

  return overrideRangeErrors;
}
