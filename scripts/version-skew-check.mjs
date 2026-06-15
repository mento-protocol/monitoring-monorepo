#!/usr/bin/env node
/**
 * Dependency version-skew check against the pnpm catalog.
 *
 * Some packages are built as standalone source roots outside this workspace
 * (Envio hosted indexer builds, App Engine's sliced Aegis deploy,
 * governance-watchdog, and alert function roots). Those packages keep literal
 * pins instead of "catalog:". This script asserts every declared version of a
 * cataloged package is either "catalog:" or exactly the catalog version.
 *
 * No external dependencies. Run: pnpm skew:check
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.env["SKEW_CHECK_ROOT"] ?? process.cwd();

/**
 * @param {string} message
 */
function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

/**
 * @param {string} message
 */
function ok(message) {
  console.log(`ok: ${message}`);
}

/**
 * @param {string} text
 * @param {string} blockName
 * @returns {string[]}
 */
function readTopLevelBlock(text, blockName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${blockName}:`);
  if (start === -1) return [];

  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line) && line.trim() !== "") break;
    block.push(line);
  }
  return block;
}

/**
 * @param {string[]} blockLines
 * @returns {Map<string, string>}
 */
function parseCatalog(blockLines) {
  const catalog = new Map();

  for (const line of blockLines) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = line.match(
      /^ {2}["']?([^"':\s]+)["']?:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/,
    );
    if (!match) continue;
    catalog.set(match[1], match[2]);
  }

  return catalog;
}

/**
 * @param {string[]} blockLines
 * @returns {string[]}
 */
function parseWorkspacePackages(blockLines) {
  return blockLines.flatMap((line) => {
    const match = line.match(/^ {2}-\s*["']?([^"'\s]+)["']?\s*$/);
    return match ? [match[1]] : [];
  });
}

const workspacePath = resolve(ROOT, "pnpm-workspace.yaml");
const workspaceText = readFileSync(workspacePath, "utf8");
const catalog = parseCatalog(readTopLevelBlock(workspaceText, "catalog"));

if (catalog.size === 0) {
  ok("no catalog entries - nothing to check");
  process.exit(0);
}

const memberDirs = parseWorkspacePackages(
  readTopLevelBlock(workspaceText, "packages"),
);
const manifestDirs = [".", ...memberDirs];
const sections = ["dependencies", "devDependencies", "optionalDependencies"];

for (const dir of manifestDirs) {
  const packageJsonPath = join(ROOT, dir, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  for (const section of sections) {
    for (const [name, rawSpec] of Object.entries(manifest[section] ?? {})) {
      const expected = catalog.get(name);
      if (!expected) continue;

      const spec = String(rawSpec);
      if (spec === "catalog:" || spec === expected) continue;

      fail(
        `${dir}/package.json ${section}.${name} is "${spec}" - expected "catalog:" or "${expected}"`,
      );
    }
  }
}

if (process.exitCode !== 1) {
  ok(`all catalog-pinned packages aligned (${[...catalog.keys()].join(", ")})`);
}
