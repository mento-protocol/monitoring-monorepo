#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIMIT_BYTES = 32 * 1024;
export const MAX_ROUTE_LIMIT_BYTES = 28 * 1024;
export const ROOT_INSTRUCTION_LIMIT_BYTES = 12 * 1024;
export const SCOPED_INSTRUCTION_LIMIT_BYTES = 16 * 1024;
export const WARNING_PERCENT = 90;

const CHAIN_SEPARATOR_BYTES = Buffer.byteLength("\n\n");

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

function validatePositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function budgetState(bytes, limitBytes, warningPercent) {
  if (bytes > limitBytes) return "over";
  if ((bytes / limitBytes) * 100 >= warningPercent) return "warning";
  return "ok";
}

function budgetMeasurement(bytes, limitBytes, warningPercent) {
  const state = budgetState(bytes, limitBytes, warningPercent);
  return {
    bytes,
    limit_bytes: limitBytes,
    percent_used: Number(((bytes / limitBytes) * 100).toFixed(1)),
    headroom_bytes: limitBytes - bytes,
    state,
    warning: state === "warning",
    oversized: state === "over",
  };
}

function formatByteCount(bytes) {
  return `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
}

export function buildContextBudgetReport({
  repoRoot,
  files,
  limitBytes,
  rootLimitBytes = ROOT_INSTRUCTION_LIMIT_BYTES,
  scopedLimitBytes = SCOPED_INSTRUCTION_LIMIT_BYTES,
  warningPercent = WARNING_PERCENT,
}) {
  validatePositiveSafeInteger("limitBytes", limitBytes);
  validatePositiveSafeInteger("rootLimitBytes", rootLimitBytes);
  validatePositiveSafeInteger("scopedLimitBytes", scopedLimitBytes);
  if (
    typeof warningPercent !== "number" ||
    !Number.isFinite(warningPercent) ||
    warningPercent <= 0 ||
    warningPercent > 100
  ) {
    throw new Error(
      "warningPercent must be a number greater than 0 and at most 100",
    );
  }

  const normalizedRoot = realpathSync(repoRoot);
  const effectiveFiles = selectEffectiveInstructionFiles(files);
  const instructions = effectiveFiles
    .map((file) => ({
      ...readInstruction(normalizedRoot, file),
      directory: path.posix.dirname(file),
    }))
    .filter(({ bytes }) => bytes > 0)
    .map((instruction) => {
      const kind = instruction.directory === "." ? "root" : "scoped";
      const fileLimitBytes =
        kind === "root" ? rootLimitBytes : scopedLimitBytes;
      return {
        ...instruction,
        kind,
        ...budgetMeasurement(instruction.bytes, fileLimitBytes, warningPercent),
      };
    });

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
    const contentBytes = chain.reduce((total, item) => total + item.bytes, 0);
    const separatorBytes =
      Math.max(0, chain.length - 1) * CHAIN_SEPARATOR_BYTES;
    const bytes = contentBytes + separatorBytes;
    return {
      route: routeInstruction.directory,
      content_bytes: contentBytes,
      separator_bytes: separatorBytes,
      ...budgetMeasurement(bytes, limitBytes, warningPercent),
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
    max_route_limit_bytes: MAX_ROUTE_LIMIT_BYTES,
    root_instruction_limit_bytes: rootLimitBytes,
    scoped_instruction_limit_bytes: scopedLimitBytes,
    warning_percent: warningPercent,
    instruction_files: instructions.map(
      ({ directory: _directory, ...instruction }) => instruction,
    ),
    routes,
    oversized_instruction_files: instructions
      .filter((instruction) => instruction.oversized)
      .map((instruction) => instruction.path),
    warning_instruction_files: instructions
      .filter((instruction) => instruction.warning)
      .map((instruction) => instruction.path),
    oversized_routes: routes
      .filter((route) => route.oversized)
      .map((route) => route.route),
    warning_routes: routes
      .filter((route) => route.warning)
      .map((route) => route.route),
  };
}

export function renderContextBudgetReport(report) {
  const lines = [
    "Agent context budget",
    `Route cap: ${report.limit_bytes.toLocaleString("en-US")} bytes; root file cap: ${report.root_instruction_limit_bytes.toLocaleString("en-US")} bytes; scoped file cap: ${report.scoped_instruction_limit_bytes.toLocaleString("en-US")} bytes`,
    `Warning threshold: ${report.warning_percent}%`,
    "",
    "Instruction files",
  ];
  for (const instruction of report.instruction_files) {
    lines.push(
      `[${instruction.state.toUpperCase()}] ${instruction.path} — ${instruction.bytes.toLocaleString("en-US")} bytes (${instruction.percent_used}% of ${instruction.kind} cap), headroom ${instruction.headroom_bytes.toLocaleString("en-US")}`,
    );
  }
  lines.push("", "Routes (Codex joins instruction files with one blank line)");
  for (const route of report.routes) {
    lines.push(
      `[${route.state.toUpperCase()}] ${route.route} — ${route.bytes.toLocaleString("en-US")} bytes (${route.percent_used}%), headroom ${route.headroom_bytes.toLocaleString("en-US")}`,
    );
    for (const contributor of route.contributors) {
      lines.push(
        `  - ${contributor.path}: ${contributor.bytes.toLocaleString("en-US")} bytes`,
      );
    }
  }
  if (report.routes.length === 0)
    lines.push("No tracked AGENTS instruction files found.");
  if (
    report.oversized_instruction_files.length > 0 ||
    report.oversized_routes.length > 0
  ) {
    lines.push("", "Strict budget violations");
    for (const instruction of report.instruction_files.filter(
      ({ oversized }) => oversized,
    )) {
      lines.push(
        `  - ${instruction.path} exceeds its ${instruction.kind} file cap by ${formatByteCount(-instruction.headroom_bytes)}.`,
      );
    }
    for (const route of report.routes.filter(({ oversized }) => oversized)) {
      lines.push(
        `  - ${route.route} exceeds the combined route cap by ${formatByteCount(-route.headroom_bytes)}.`,
      );
    }
    lines.push(
      "Move detailed procedures to the narrowest canonical note, checklist, or skill and keep a concise routing pointer in AGENTS.md; do not raise the cap.",
    );
  }
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
when the root file, a scoped file, or a root-plus-scoped route exceeds its cap.
The repository route policy cannot exceed ${MAX_ROUTE_LIMIT_BYTES} bytes.
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
  if (limitBytes > MAX_ROUTE_LIMIT_BYTES) {
    throw new Error(
      `effective project-doc limit ${limitBytes} exceeds the repository policy maximum ${MAX_ROUTE_LIMIT_BYTES}; set project_doc_max_bytes at or below ${MAX_ROUTE_LIMIT_BYTES}`,
    );
  }
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
  return options.strict &&
    (report.oversized_instruction_files.length > 0 ||
      report.oversized_routes.length > 0)
    ? 1
    : 0;
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
