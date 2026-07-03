#!/usr/bin/env node
/**
 * File-size watchlist reporter for source files covered by this repo's
 * max-lines policy. Generated output belongs in docs/notes/file-size-watch.md
 * or a GitHub Issue, never BACKLOG.md.
 *
 * Run:
 *   node scripts/file-size-watchlist.mjs
 *   node scripts/file-size-watchlist.mjs --format issue
 *   node scripts/file-size-watchlist.mjs --format json --fail-on hard
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SOFT_CAP = 600;
export const HARD_CAP = 1000;
export const NEAR_HARD_CAP = 950;

const SOURCE_SCOPES = [
  {
    label: "dashboard",
    prefix: "ui-dashboard/src/",
    extensions: [".ts", ".tsx"],
    exclude: (path) => path === "ui-dashboard/src/lib/types.ts",
  },
  {
    label: "indexer",
    prefix: "indexer-envio/src/",
    extensions: [".ts"],
  },
  {
    label: "integration-probes",
    prefix: "integration-probes/src/",
    extensions: [".ts"],
  },
  {
    label: "metrics-bridge",
    prefix: "metrics-bridge/src/",
    extensions: [".ts"],
  },
  {
    label: "shared-config",
    prefix: "shared-config/src/",
    extensions: [".ts"],
  },
  {
    label: "aegis",
    prefix: "aegis/src/",
    extensions: [".ts"],
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

export function isTestOrGenerated(path) {
  return (
    path.includes("/.envio/") ||
    path.includes("/__tests__/") ||
    /\.(test|spec)\.(ts|tsx)$/.test(path)
  );
}

export function scopeForPath(path) {
  if (isTestOrGenerated(path)) return null;
  return (
    SOURCE_SCOPES.find((scope) => {
      if (!path.startsWith(scope.prefix)) return false;
      if (!scope.extensions.some((extension) => path.endsWith(extension))) {
        return false;
      }
      return scope.exclude === undefined || !scope.exclude(path);
    }) ?? null
  );
}

export function countLines(source) {
  const raw = source === "" ? 0 : source.split(/\r?\n/).length;
  let rough = 0;
  let inBlockComment = false;

  for (const line of source.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (trimmed === "") continue;

    if (inBlockComment) {
      const closeIndex = trimmed.indexOf("*/");
      if (closeIndex === -1) continue;
      inBlockComment = false;
      trimmed = trimmed.slice(closeIndex + 2).trim();
      if (trimmed === "") continue;
    }

    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }

    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/")
    ) {
      continue;
    }

    rough += 1;
  }

  return { raw, rough };
}

function statusForCounts({ raw, rough }) {
  if (rough >= HARD_CAP) return "hard";
  if (rough >= NEAR_HARD_CAP) return "near-hard";
  if (rough >= SOFT_CAP) return "soft";
  if (raw >= SOFT_CAP) return "watch";
  return "ok";
}

export function scanFileList(files, readFile) {
  return files
    .map((path) => normalizePath(path))
    .flatMap((path) => {
      const scope = scopeForPath(path);
      if (scope === null) return [];
      const counts = countLines(readFile(path));
      const status = statusForCounts(counts);
      if (status === "ok") return [];
      return [
        {
          path,
          package: scope.label,
          raw: counts.raw,
          rough: counts.rough,
          status,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.rough - a.rough || b.raw - a.raw || a.path.localeCompare(b.path),
    );
}

export function parseBaselineRows(source) {
  const rows = new Map();
  let header = null;

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3 || cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }

    const normalized = cells.map((cell) => cell.toLowerCase());
    if (
      normalized.includes("file") &&
      (normalized.includes("raw") || normalized.includes("lines"))
    ) {
      header = normalized;
      continue;
    }
    if (header === null) continue;

    const raw = rawCellValue(cells, header);
    const path = pathCellValue(cells, header);
    if (raw === null || path === null) continue;
    rows.set(path, raw);
  }
  return rows;
}

function rawCellValue(cells, header) {
  const rawIndex = header.findIndex(
    (cell) => cell === "raw" || cell === "lines",
  );
  if (rawIndex === -1) return null;
  const rawCandidate = cells[rawIndex]?.replace(/,/g, "") ?? "";
  const raw = Number(rawCandidate);
  return Number.isFinite(raw) ? raw : null;
}

function pathCellValue(cells, header) {
  const pathIndex = header.findIndex((cell) => cell === "file");
  if (pathIndex === -1) return null;
  const match = cells[pathIndex]?.match(/`([^`]+)`/);
  return match ? match[1].replaceAll("\\_", "_") : null;
}

export function withRawDeltas(rows, baselineRows) {
  return rows.map((row) => {
    const baselineRaw = baselineRows.get(row.path);
    return {
      ...row,
      rawDelta: baselineRaw === undefined ? null : row.raw - baselineRaw,
    };
  });
}

function trackedFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return output.trim() === "" ? [] : output.trim().split(/\n/);
}

function readRepoFile(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

function statusLabel(status) {
  switch (status) {
    case "hard":
      return "hard cap";
    case "near-hard":
      return "near hard cap";
    case "soft":
      return "soft cap";
    case "watch":
      return "watch";
    default:
      return status;
  }
}

function deltaLabel(delta) {
  if (delta === null || delta === undefined) return "(new)";
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

export function formatMarkdown(rows, options = {}) {
  const generatedAt =
    options.generatedAt ?? new Date().toISOString().slice(0, 10);
  const lines = [
    `Counts refreshed ${generatedAt}. Generated by \`node scripts/file-size-watchlist.mjs\`.`,
    "",
    "Scope: source files in package configs that enforce `max-lines`; tests, generated files, and `ui-dashboard/src/lib/types.ts` are excluded.",
    "`raw` is physical lines; `rough` approximates ESLint after `skipBlankLines` and `skipComments`.",
    "Use `--format issue` for GitHub Issues; do not append this report to `BACKLOG.md`.",
    "",
    "| Rough | Raw | Delta | Status | File |",
    "| ----: | --: | ----: | ------ | ---- |",
  ];

  if (rows.length === 0) {
    lines.push("| 0 | 0 | 0 | ok | No files above the watch threshold |");
    return `${lines.join("\n")}\n`;
  }

  for (const row of rows) {
    lines.push(
      `| ${row.rough} | ${row.raw} | ${deltaLabel(row.rawDelta)} | ${statusLabel(row.status)} | \`${row.path}\` |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatIssue(rows, options = {}) {
  const generatedAt =
    options.generatedAt ?? new Date().toISOString().slice(0, 10);
  return [
    "## The Problem",
    "",
    "- The file-size drift report must live in GitHub Issues or docs notes now that active work moved out of `BACKLOG.md`.",
    "- Files near the effective 1,000-line hard cap need explicit split decisions before routine feature work pushes them over the lint gate.",
    "",
    "## Current Report",
    "",
    formatMarkdown(rows, { generatedAt }).trimEnd(),
    "",
    "## Suggested Handling",
    "",
    "- Refactor `hard cap` and `near hard cap` files before adding behavior to them.",
    "- Keep `soft cap` and `watch` rows in `docs/notes/file-size-watch.md` unless a concrete split is ready.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    format: "markdown",
    failOn: "none",
    limit: null,
    baseline: "docs/notes/file-size-watch.md",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--format") {
      args.format = argv[++index];
    } else if (arg === "--fail-on") {
      args.failOn = argv[++index];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++index]);
    } else if (arg === "--baseline") {
      args.baseline = argv[++index];
    } else if (arg === "--no-baseline") {
      args.baseline = null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["markdown", "issue", "json"].includes(args.format)) {
    throw new Error("--format must be markdown, issue, or json");
  }
  if (!["none", "soft", "hard"].includes(args.failOn)) {
    throw new Error("--fail-on must be none, soft, or hard");
  }
  if (
    args.limit !== null &&
    (!Number.isInteger(args.limit) || args.limit < 1)
  ) {
    throw new Error("--limit must be a positive integer");
  }

  return args;
}

function shouldFail(rows, failOn) {
  if (failOn === "hard") return rows.some((row) => row.status === "hard");
  if (failOn === "soft") {
    return rows.some((row) =>
      ["hard", "near-hard", "soft"].includes(row.status),
    );
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);
  if (!existsSync(join(root, ".git"))) {
    throw new Error(`Not a git checkout: ${root}`);
  }

  const rows = scanFileList(trackedFiles(root), (path) =>
    readRepoFile(root, path),
  );
  const baselineRows =
    args.baseline === null
      ? new Map()
      : parseBaselineRows(readOptionalBaseline(root, args.baseline));
  const rowsWithDeltas = withRawDeltas(rows, baselineRows);
  const limitedRows =
    args.limit === null ? rowsWithDeltas : rowsWithDeltas.slice(0, args.limit);

  if (args.format === "json") {
    console.log(
      JSON.stringify(
        { softCap: SOFT_CAP, hardCap: HARD_CAP, rows: rowsWithDeltas },
        null,
        2,
      ),
    );
  } else if (args.format === "issue") {
    console.log(formatIssue(limitedRows));
  } else {
    console.log(formatMarkdown(limitedRows).trimEnd());
  }

  if (shouldFail(rowsWithDeltas, args.failOn)) {
    process.exitCode = 1;
  }
}

function readOptionalBaseline(root, baselinePath) {
  const path = resolve(root, baselinePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const _private = {
  parseArgs,
  shouldFail,
  statusForCounts,
};
