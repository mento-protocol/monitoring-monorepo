#!/usr/bin/env node
/**
 * File-size watchlist reporter for source files covered by this repo's
 * max-lines policy, plus scripts/, where no lint rule enforces one (ADR 0065).
 * Generated output belongs in docs/notes/file-size-watch.md or a GitHub Issue,
 * never BACKLOG.md.
 *
 * Run:
 *   node scripts/repo-health/file-size-watchlist.mjs
 *   node scripts/repo-health/file-size-watchlist.mjs --format issue
 *   node scripts/repo-health/file-size-watchlist.mjs --format json --fail-on hard
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SOFT_CAP = 600;
export const HARD_CAP = 1000;
export const NEAR_HARD_CAP = 950;

/**
 * `scripts/` files this repository has decided not to split, each with the
 * mechanism that makes the split a security decision rather than a refactor.
 * Exact paths only — a pattern would let the list grow without a reviewer
 * seeing which files joined. It stays short on purpose: a file whose split is
 * merely expensive, or is already owned by an issue, belongs in the report as a
 * normal row. ADR 0065 owns the list and its review cadence.
 */
export const SCRIPTS_EXEMPTIONS = [
  {
    reason:
      "trust root: the wrapper hashes its own blob against frozen HEAD before an explicit-ref review, so a sourced sibling falls outside the identity it proves",
    paths: ["scripts/agent-autoreview.sh"],
  },
  {
    reason:
      "trust root: the wrapper materializes the entry point, core, native Darwin identity runtime, and process-identity dependency under a 2 MB aggregate cap from explicit trust lists and private nested directories; splitting either large helper changes the attested runtime",
    paths: [
      "scripts/agent-autoreview.mjs",
      "scripts/agent-autoreview-core.mjs",
    ],
  },
];

export function exemptionReason(path) {
  for (const entry of SCRIPTS_EXEMPTIONS) {
    if (entry.paths.includes(path)) return entry.reason;
  }
  return null;
}

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
    includeTests: true,
  },
  {
    // No ESLint `max-lines` reaches scripts/ — the root config sets none — so
    // this scope is the only size signal the tree has. The extension list
    // mirrors what the root config lints (`.mjs`, `.js`, `.cjs`) plus shell and
    // native C sources. Tests are excluded as everywhere but Aegis: splitting
    // a scripts/ suite means re-measuring a manifest floor or
    // re-enumerating a paths-filter, per-file work a size row cannot describe.
    // Where the tree wanted a test-side gate it built one —
    // check-sentry-suites-in-ci.test.mjs hard-caps 20 files, and the select and
    // brief Sentry legs pin their own modules the same way.
    label: "scripts",
    prefix: "scripts/",
    extensions: [".mjs", ".js", ".cjs", ".sh", ".c"],
    exemption: exemptionReason,
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

export function isGenerated(path) {
  return path.includes("/.envio/") || path.includes("/__generated__/");
}

function isExcludedTest(path, scope) {
  if (scope.includeTests === true) return false;
  return (
    path.includes("/__tests__/") ||
    /\.(test|spec)\.(ts|tsx|mjs|js|sh|c)$/.test(path)
  );
}

export function scopeForPath(path) {
  if (isGenerated(path)) return null;
  const scope =
    SOURCE_SCOPES.find((candidate) => {
      if (!path.startsWith(candidate.prefix)) return false;
      if (!candidate.extensions.some((extension) => path.endsWith(extension))) {
        return false;
      }
      return candidate.exclude === undefined || !candidate.exclude(path);
    }) ?? null;
  if (scope === null || isExcludedTest(path, scope)) return null;
  return scope;
}

export function countLines(source, options = {}) {
  const physicalLines =
    source === "" ? [] : source.replace(/\r?\n$/, "").split(/\r?\n/);
  const raw = physicalLines.length;
  let rough = 0;
  let inBlockComment = false;

  for (const line of physicalLines) {
    let trimmed = line.trim();
    if (trimmed === "") continue;

    // Shell has no `//` or `/* */`; without this a `#` comment counts as code
    // and the rough column overstates every .sh file in the report. This is a
    // line-prefix approximation, not a shell parser: a heredoc payload line
    // starting with `#` reads as a comment. `raw` stays exact either way.
    if (options.hashComments === true) {
      if (trimmed.startsWith("#")) continue;
      rough += 1;
      continue;
    }

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
      const counts = countLines(readFile(path), {
        hashComments: path.endsWith(".sh"),
      });
      const capStatus = statusForCounts(counts);
      if (capStatus === "ok") return [];
      const reason = scope.exemption?.(path) ?? null;
      return [
        {
          path,
          package: scope.label,
          raw: counts.raw,
          rough: counts.rough,
          status: reason === null ? capStatus : "exempt",
          ...(reason === null ? {} : { capStatus, reason }),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.rough - a.rough || b.raw - a.raw || a.path.localeCompare(b.path),
    );
}

/** Split a scan into the actionable table and the reasoned exemption table. */
export function partitionExempt(rows) {
  return {
    tracked: rows.filter((row) => row.status !== "exempt"),
    exempt: rows.filter((row) => row.status === "exempt"),
  };
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
  const candidate = cells[pathIndex] ?? "";
  const match = candidate.match(/`([^`]+)`/);
  return (match ? match[1] : candidate).replaceAll("\\_", "_").trim() || null;
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
  // NUL-delimited: git C-quotes a path holding a newline or a non-ASCII byte
  // when it writes one per line, and a quoted path matches no scope prefix, so
  // an over-cap file would drop out of the report with nothing to show for it.
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return output.split("\0").filter((path) => path !== "");
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
  const { tracked, exempt } = partitionExempt(rows);
  const lines = [
    `Counts refreshed ${generatedAt}. Generated by \`node scripts/repo-health/file-size-watchlist.mjs\`.`,
    "",
    "Scope: source files in package configs that enforce `max-lines`, plus `scripts/` JavaScript, shell, and native C sources; generated files, tests outside Aegis, and `ui-dashboard/src/lib/types.ts` are excluded.",
    "`raw` is physical lines; `rough` approximates ESLint after `skipBlankLines` and `skipComments`.",
    "Use `--format issue` for GitHub Issues; do not append this report to `BACKLOG.md`.",
    "",
    "| Rough | Raw | Delta | Status | File |",
    "| ----: | --: | ----: | ------ | ---- |",
  ];

  if (tracked.length === 0) {
    lines.push("| 0 | 0 | 0 | ok | No files above the watch threshold |");
  }
  for (const row of tracked) {
    lines.push(
      `| ${row.rough} | ${row.raw} | ${deltaLabel(row.rawDelta)} | ${statusLabel(row.status)} | \`${row.path}\` |`,
    );
  }
  return `${lines.join("\n")}${formatExemptSection(exempt)}\n`;
}

function formatExemptSection(exempt) {
  if (exempt.length === 0) return "";
  const lines = [
    "",
    "",
    `Exempt (${exempt.length}): splitting these would change a named mechanism rather than refactor a file, so they never open an issue. \`docs/adr/0065-scripts-file-size-watchlist-scope.md\` owns the list and its review cadence.`,
    "",
    "| Rough | Raw | Cap | File | Why it is exempt |",
    "| ----: | --: | --- | ---- | ---------------- |",
  ];
  for (const row of exempt) {
    // A raw `|` would split the cell, and parseBaselineRows reads this table
    // back by fixed column index — one pipe misreads every following column.
    const reason = row.reason.replaceAll("|", "\\|");
    lines.push(
      `| ${row.rough} | ${row.raw} | ${statusLabel(row.capStatus)} | \`${row.path}\` | ${reason} |`,
    );
  }
  return lines.join("\n");
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
    "- Do not re-litigate an exempt row. Its mechanism is named beside it; changing that mechanism is the only way in.",
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
  // `--limit` trims the actionable queue only. Exempt rows always ship whole:
  // a truncated exemption reads as a silently dropped file.
  const { tracked, exempt } = partitionExempt(rowsWithDeltas);
  const limitedTracked =
    args.limit === null ? tracked : tracked.slice(0, args.limit);
  const limitedRows = [...limitedTracked, ...exempt];

  if (args.format === "json") {
    console.log(
      JSON.stringify(
        { softCap: SOFT_CAP, hardCap: HARD_CAP, rows: limitedTracked, exempt },
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
