#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIMIT_BYTES = 32 * 1024;

const INSTRUCTION_FILENAMES = new Set(["AGENTS.md", "AGENTS.override.md"]);

function isWithinRoot(repoRoot, candidate) {
  const relative = path.relative(repoRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function parseProjectDocMaxBytes(configText) {
  const values = [];
  let table = null;
  for (const [index, line] of configText.split("\n").entries()) {
    const trimmed = line.replace(/\s+#.*$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tableMatch = /^(?:\[([^\]]+)]|\[\[([^\]]+)]])$/.exec(trimmed);
    if (tableMatch) {
      table = tableMatch[1] ?? tableMatch[2];
      continue;
    }
    const keyMatch = /^project_doc_max_bytes\s*=\s*(\S+)$/.exec(trimmed);
    if (!keyMatch) continue;
    if (table !== null) {
      throw new Error(
        `project_doc_max_bytes must be a top-level key (found under [${table}] on line ${index + 1})`,
      );
    }
    values.push(keyMatch[1]);
  }

  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new Error(
      "project_doc_max_bytes must appear exactly once as a positive TOML integer",
    );
  }

  if (!/^\d(?:_?\d)*$/.test(values[0])) {
    throw new Error("project_doc_max_bytes must be a positive TOML integer");
  }
  const normalized = values[0].replaceAll("_", "");

  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("project_doc_max_bytes must be a positive safe integer");
  }
  return value;
}

export function resolveProjectDocMaxBytes(repoRoot) {
  const configPath = path.join(repoRoot, ".codex", "config.toml");
  if (!existsSync(configPath)) return DEFAULT_LIMIT_BYTES;
  const configured = parseProjectDocMaxBytes(readFileSync(configPath, "utf8"));
  return configured ?? DEFAULT_LIMIT_BYTES;
}

export function trackedInstructionFiles(repoRoot) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => INSTRUCTION_FILENAMES.has(path.posix.basename(file)))
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort();
}

export function selectEffectiveInstructionFiles(files) {
  const byDirectory = new Map();
  for (const file of [...files].sort()) {
    const filename = path.posix.basename(file);
    if (!INSTRUCTION_FILENAMES.has(filename)) continue;
    const directory = path.posix.dirname(file);
    const current = byDirectory.get(directory);
    if (!current || filename === "AGENTS.override.md") {
      byDirectory.set(directory, file);
    }
  }
  return [...byDirectory.values()].sort();
}

function directoryIsAncestor(ancestor, candidate) {
  if (ancestor === ".") return true;
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function directoryDepth(directory) {
  return directory === "." ? 0 : directory.split("/").length;
}

function readInstruction(repoRoot, file) {
  const absolute = path.resolve(repoRoot, file);
  if (!isWithinRoot(repoRoot, absolute)) {
    throw new Error(`${file}: instruction path escapes the repository root`);
  }
  if (!existsSync(absolute)) {
    throw new Error(`${file}: tracked instruction file is missing`);
  }

  const resolved = realpathSync(absolute);
  if (!isWithinRoot(repoRoot, resolved)) {
    throw new Error(
      `${file}: instruction symlink resolves outside the repository root`,
    );
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`${file}: instruction path is not a regular file`);
  }

  const content = readFileSync(resolved);
  return { path: file, bytes: content.byteLength };
}

export function buildContextBudgetReport({ repoRoot, files, limitBytes }) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error("limitBytes must be a positive safe integer");
  }

  const normalizedRoot = realpathSync(repoRoot);
  const effectiveFiles = selectEffectiveInstructionFiles(files);
  const instructions = effectiveFiles.map((file) => ({
    ...readInstruction(normalizedRoot, file),
    directory: path.posix.dirname(file),
  }));

  const routes = instructions.map((routeInstruction) => {
    const chain = instructions
      .filter((instruction) =>
        directoryIsAncestor(instruction.directory, routeInstruction.directory),
      )
      .sort((left, right) => {
        const depthDifference =
          directoryDepth(left.directory) - directoryDepth(right.directory);
        return depthDifference || left.path.localeCompare(right.path);
      })
      .map(({ path: file, bytes }) => ({ path: file, bytes }));
    const bytes = chain.reduce((total, item) => total + item.bytes, 0);
    return {
      route: routeInstruction.directory,
      bytes,
      limit_bytes: limitBytes,
      percent_used: Number(((bytes / limitBytes) * 100).toFixed(1)),
      headroom_bytes: limitBytes - bytes,
      oversized: bytes > limitBytes,
      contributors: [...chain].sort(
        (left, right) =>
          right.bytes - left.bytes || left.path.localeCompare(right.path),
      ),
      chain,
    };
  });

  routes.sort((left, right) => left.route.localeCompare(right.route));
  return {
    limit_bytes: limitBytes,
    default_limit_bytes: DEFAULT_LIMIT_BYTES,
    routes,
    oversized_routes: routes
      .filter((route) => route.oversized)
      .map((route) => route.route),
  };
}

export function renderContextBudgetReport(report) {
  const lines = [
    "Agent context budget",
    `Limit: ${report.limit_bytes.toLocaleString("en-US")} bytes`,
    "",
  ];
  for (const route of report.routes) {
    const state = route.oversized ? "OVER" : "OK";
    lines.push(
      `[${state}] ${route.route} — ${route.bytes.toLocaleString("en-US")} bytes (${route.percent_used}%), headroom ${route.headroom_bytes.toLocaleString("en-US")}`,
    );
    for (const contributor of route.contributors) {
      lines.push(
        `  - ${contributor.path}: ${contributor.bytes.toLocaleString("en-US")} bytes`,
      );
    }
  }
  if (report.routes.length === 0)
    lines.push("No tracked AGENTS instruction files found.");
  return `${lines.join("\n")}\n`;
}

export function parseContextBudgetArgs(argv) {
  const options = {
    format: "text",
    strict: false,
    repoRoot: process.cwd(),
    limitBytes: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.format = "json";
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--root") options.repoRoot = argv[(index += 1)];
    else if (arg === "--limit") options.limitBytes = Number(argv[(index += 1)]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.repoRoot) throw new Error("--root requires a path");
  if (
    options.limitBytes !== null &&
    (!Number.isSafeInteger(options.limitBytes) || options.limitBytes <= 0)
  ) {
    throw new Error("--limit requires a positive integer");
  }
  return options;
}

function usage() {
  return `Usage: node scripts/agent-context-budget.mjs [--json] [--strict] [--limit BYTES] [--root PATH]

Report mode always exits zero after a successful scan. --strict exits non-zero
when any root-plus-scoped instruction route exceeds the effective byte limit.
`;
}

export function runContextBudgetCli(argv) {
  const options = parseContextBudgetArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  const limitBytes = options.limitBytes ?? resolveProjectDocMaxBytes(repoRoot);
  const report = buildContextBudgetReport({
    repoRoot,
    files: trackedInstructionFiles(repoRoot),
    limitBytes,
  });
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderContextBudgetReport(report));
  }
  return options.strict && report.oversized_routes.length > 0 ? 1 : 0;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    process.exitCode = runContextBudgetCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-context-budget: ${message}\n`);
    process.exitCode = 2;
  }
}
