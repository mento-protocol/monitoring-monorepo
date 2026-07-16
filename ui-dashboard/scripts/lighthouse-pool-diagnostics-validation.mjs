import { resolve } from "node:path";

export const DEFAULT_EXPECTED_RUNS = 3;

export function usage() {
  return [
    "Usage:",
    "  node ui-dashboard/scripts/lighthouse-pool-diagnostics.mjs \\",
    "    --dir <lighthouse-report-directory> \\",
    "    --path <exact-pathname-and-query> \\",
    "    [--expected-runs 3] \\",
    "    --output-json <diagnostics.json> \\",
    "    --output-markdown <diagnostics.md>",
  ].join("\n");
}

export function normalizeTargetPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error("--path must be an absolute pathname beginning with /");
  }
  try {
    const target = new URL(value, "https://lighthouse.invalid");
    return `${target.pathname}${target.search}`;
  } catch (error) {
    throw new Error(
      `--path is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseArgs(argv) {
  const parsed = { expectedRuns: DEFAULT_EXPECTED_RUNS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (
      arg !== "--dir" &&
      arg !== "--path" &&
      arg !== "--expected-runs" &&
      arg !== "--output-json" &&
      arg !== "--output-markdown"
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--expected-runs") {
      const expectedRuns = Number(value);
      if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
        throw new Error("--expected-runs must be a positive integer");
      }
      parsed.expectedRuns = expectedRuns;
    } else if (arg === "--dir") {
      parsed.dir = value;
    } else if (arg === "--path") {
      parsed.path = value;
    } else if (arg === "--output-json") {
      parsed.outputJson = value;
    } else {
      parsed.outputMarkdown = value;
    }
  }

  if (parsed.help) return parsed;
  for (const [key, flag] of [
    ["dir", "--dir"],
    ["path", "--path"],
    ["outputJson", "--output-json"],
    ["outputMarkdown", "--output-markdown"],
  ]) {
    if (!parsed[key]) throw new Error(`${flag} is required`);
  }
  if (resolve(parsed.outputJson) === resolve(parsed.outputMarkdown)) {
    throw new Error("--output-json and --output-markdown must be different");
  }
  parsed.path = normalizeTargetPath(parsed.path);
  return parsed;
}
