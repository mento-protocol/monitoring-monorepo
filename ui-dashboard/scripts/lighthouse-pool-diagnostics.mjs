#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeReports,
  median,
} from "./lighthouse-pool-diagnostics-aggregation.mjs";
import {
  extractLcpElement,
  extractLcpPhases,
  extractRunDiagnostics,
  readLighthouseReports,
} from "./lighthouse-pool-diagnostics-lhr.mjs";
import { formatMarkdown } from "./lighthouse-pool-diagnostics-markdown.mjs";
import {
  normalizeTargetPath,
  parseArgs,
  usage,
} from "./lighthouse-pool-diagnostics-validation.mjs";

export {
  analyzeReports,
  extractLcpElement,
  extractLcpPhases,
  extractRunDiagnostics,
  formatMarkdown,
  median,
  normalizeTargetPath,
  parseArgs,
  readLighthouseReports,
};

function writeOutputs(analysis, outputJson, outputMarkdown) {
  const jsonPath = resolve(outputJson);
  const markdownPath = resolve(outputMarkdown);
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
  writeFileSync(markdownPath, formatMarkdown(analysis));
}

export function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const reports = readLighthouseReports(options.dir);
  const analysis = analyzeReports(reports, {
    targetPath: options.path,
    expectedRuns: options.expectedRuns,
    sourceDirectory: options.dir,
  });
  writeOutputs(analysis, options.outputJson, options.outputMarkdown);
  console.log(
    `Wrote ${analysis.runCount} pool-detail Lighthouse run(s) to ${resolve(options.outputJson)} and ${resolve(options.outputMarkdown)}`,
  );
  return analysis;
}

export function main(argv = process.argv.slice(2)) {
  try {
    runCli(argv);
    return 0;
  } catch (error) {
    console.error(
      `::error::Lighthouse pool diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
