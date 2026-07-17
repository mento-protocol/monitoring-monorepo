#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildDocumentationInventory,
  DOCS_INDEX_PATH,
  parseDocumentationMetadata,
  renderDocumentationIndex,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";

function parseArgs(argv) {
  const options = { mode: "print", repoRoot: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.mode = "write";
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--json") options.mode = "json";
    else if (arg === "--root") options.repoRoot = argv[(index += 1)];
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.repoRoot) throw new Error("--root requires a path");
  return options;
}

function usage() {
  return `Usage: node scripts/docs-index.mjs [--write | --check | --json] [--root PATH]

The catalog models the proposed working tree from tracked and non-ignored
untracked Markdown, excluding CLAUDE.md and .claude/skills mirrors. --write
updates docs/README.md; --check fails on drift, invalid classification,
canonical metadata gaps, or broken internal links.
`;
}

function existingLastVerified(repoRoot) {
  const output = path.join(repoRoot, DOCS_INDEX_PATH);
  if (!existsSync(output)) return new Date().toISOString().slice(0, 10);
  const metadata = parseDocumentationMetadata(
    DOCS_INDEX_PATH,
    readFileSync(output, "utf8"),
  );
  return metadata?.last_verified || new Date().toISOString().slice(0, 10);
}

function collect(repoRoot) {
  const inventory = buildDocumentationInventory({
    repoRoot,
    files: trackedDocumentationFiles(repoRoot),
  });
  const rendered = renderDocumentationIndex(inventory, {
    lastVerified: existingLastVerified(repoRoot),
  });
  return { inventory, rendered };
}

function printProblems(inventory) {
  for (const error of inventory.errors)
    process.stderr.write(`docs-index: ${error}\n`);
  for (const warning of inventory.warnings)
    process.stderr.write(`docs-index: ${warning}\n`);
  for (const link of inventory.broken_links) {
    process.stderr.write(
      `docs-index: ${link.source}: broken link '${link.target}' (${link.reason})\n`,
    );
  }
}

function hasBlockingProblems(inventory) {
  return (
    inventory.errors.length > 0 ||
    inventory.warnings.length > 0 ||
    inventory.broken_links.length > 0
  );
}

function writeUntilStable(repoRoot) {
  const output = path.join(repoRoot, DOCS_INDEX_PATH);
  let result;
  for (let pass = 0; pass < 8; pass += 1) {
    result = collect(repoRoot);
    if (hasBlockingProblems(result.inventory))
      return { ...result, stable: false };
    const current = existsSync(output) ? readFileSync(output, "utf8") : null;
    if (current === result.rendered) return { ...result, stable: true };
    writeFileSync(output, result.rendered);
  }
  result = collect(repoRoot);
  return {
    ...result,
    stable: readFileSync(output, "utf8") === result.rendered,
  };
}

export function runDocsIndex(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const repoRoot = realpathSync(path.resolve(options.repoRoot));

  if (options.mode === "write") {
    const result = writeUntilStable(repoRoot);
    printProblems(result.inventory);
    if (hasBlockingProblems(result.inventory)) return 1;
    if (!result.stable) {
      process.stderr.write("docs-index: generated catalog did not converge\n");
      return 1;
    }
    process.stdout.write(`wrote ${DOCS_INDEX_PATH}\n`);
    return 0;
  }

  const { inventory, rendered } = collect(repoRoot);
  if (options.mode === "json") {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return hasBlockingProblems(inventory) ? 1 : 0;
  }
  if (options.mode === "print") {
    process.stdout.write(rendered);
    return hasBlockingProblems(inventory) ? 1 : 0;
  }

  printProblems(inventory);
  const output = path.join(repoRoot, DOCS_INDEX_PATH);
  if (!existsSync(output)) {
    process.stderr.write(
      `docs-index: ${DOCS_INDEX_PATH} is missing; run pnpm docs:index --write\n`,
    );
    return 1;
  }
  if (readFileSync(output, "utf8") !== rendered) {
    process.stderr.write(
      `docs-index: ${DOCS_INDEX_PATH} is stale; run pnpm docs:index --write\n`,
    );
    return 1;
  }
  return hasBlockingProblems(inventory) ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = runDocsIndex(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`docs-index: ${message}\n`);
    process.exitCode = 2;
  }
}
