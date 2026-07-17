#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { buildAuditPacket, renderAuditPacket } from "./docs-audit-helpers.mjs";
import {
  buildDocumentationInventory,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    format: "markdown",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--root") options.repoRoot = takeValue();
    else if (arg === "--date") options.date = takeValue();
    else if (arg === "--lane") options.lane = takeValue();
    else if (arg === "--shard") options.shard = Number(takeValue());
    else if (arg === "--format") options.format = takeValue();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["markdown", "json"].includes(options.format)) {
    throw new Error("--format must be markdown or json");
  }
  return options;
}

function usage() {
  return `Usage: node scripts/docs-audit.mjs [options]

Options:
  --date YYYY-MM-DD       Deterministic cycle date (default: today)
  --lane NAME             Select one of the six gardening lanes
  --shard NUMBER          Select a one-based shard within the lane
  --format markdown|json  Output format (default: markdown)
  --dry-run               Mark the packet as a non-mutating workflow preview
  --root PATH             Repository root
`;
}

export function runDocsAudit(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  const inventory = buildDocumentationInventory({
    repoRoot,
    files: trackedDocumentationFiles(repoRoot),
  });
  if (inventory.errors.length) {
    for (const error of inventory.errors)
      process.stderr.write(`docs-audit: ${error}\n`);
    return 1;
  }
  const packet = buildAuditPacket({
    repoRoot,
    inventory,
    date: options.date,
    lane: options.lane,
    shard: options.shard,
    dryRun: options.dryRun,
  });
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(packet, null, 2)}\n`
      : renderAuditPacket(packet),
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = runDocsAudit(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`docs-audit: ${message}\n`);
    process.exitCode = 2;
  }
}
