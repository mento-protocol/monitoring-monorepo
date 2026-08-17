#!/usr/bin/env node
/**
 * CodeScene-lite git history report. Surfaces hotspots, change coupling,
 * ownership concentration, ownership spread, and a weekly delta.
 *
 * Strictly advisory: no deps, no CI gating. Output: reports/code-health-history.md
 *
 * Run: `pnpm code-health:history`
 *
 * Why these metrics:
 *   - Hotspots: high-churn × high-LOC files yield the most ROI on refactor effort
 *     (the CodeScene "code-as-a-crime-scene" idea).
 *   - Change coupling: files that always move together are effectively one concern;
 *     a refactor candidate.
 *   - Concentration: when one person owns a file, knowledge is fragile.
 *   - Spread: when many people touch a file, design intent can drift.
 *   - Weekly delta: surfaces emerging hotspots before they become permanent.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

const HOTSPOT_TOP = 20;
const COUPLING_TOP = 10;
const COUPLING_MIN_COCHANGE = 5;
const COUPLING_MIN_RATE = 0.4;
const CONCENTRATION_SHARE = 0.8;
const CONCENTRATION_MIN_COMMITS = 3;
const SPREAD_MIN_AUTHORS = 5;
const WINDOW_HOTSPOT_DAYS = 90;
const WINDOW_LONG_DAYS = 180;

const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx|sql)$/;
const PAIR_SEP = "\0";

function git(args) {
  const r = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function parseLog(sinceDays) {
  const since = new Date(Date.now() - sinceDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const raw = git([
    "log",
    "--numstat",
    `--since=${since}`,
    "--no-merges",
    "--pretty=format:COMMIT|%H|%an|%aI",
  ]);
  const commits = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("COMMIT|")) {
      if (cur) commits.push(cur);
      const [, sha, author, isoDate] = line.split("|");
      cur = { sha, author, isoDate, files: [] };
    } else if (line.trim() && cur) {
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      const [added, deleted, path] = parts;
      if (added === "-" || deleted === "-") continue;
      if (path.includes("=>")) continue;
      cur.files.push({ path });
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

const lineCountCache = new Map();
function lineCount(path) {
  if (lineCountCache.has(path)) return lineCountCache.get(path);
  let count;
  try {
    const buf = readFileSync(join(REPO_ROOT, path), "utf8");
    count = buf.split("\n").length;
  } catch {
    count = 0;
  }
  lineCountCache.set(path, count);
  return count;
}

function topHotspots(commits) {
  const counts = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      if (!SOURCE_EXT.test(f.path)) continue;
      counts.set(f.path, (counts.get(f.path) || 0) + 1);
    }
  }
  const rows = [];
  for (const [path, commitCount] of counts) {
    const loc = lineCount(path);
    if (loc === 0) continue;
    rows.push({ path, commits: commitCount, loc, score: commitCount * loc });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, HOTSPOT_TOP);
}

function changeCoupling(commits) {
  const pairCounts = new Map();
  const fileCounts = new Map();
  for (const c of commits) {
    const files = c.files
      .filter((f) => SOURCE_EXT.test(f.path))
      .map((f) => f.path);
    for (const f of files) fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [a, b] =
          files[i] < files[j] ? [files[i], files[j]] : [files[j], files[i]];
        const key = `${a}${PAIR_SEP}${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const rows = [];
  for (const [key, coCount] of pairCounts) {
    if (coCount < COUPLING_MIN_COCHANGE) continue;
    const [a, b] = key.split(PAIR_SEP);
    if (lineCount(a) === 0 || lineCount(b) === 0) continue;
    const minIndividual = Math.min(fileCounts.get(a), fileCounts.get(b));
    const rate = coCount / minIndividual;
    if (rate < COUPLING_MIN_RATE) continue;
    rows.push({ a, b, coCount, rate });
  }
  rows.sort((x, y) => y.coCount - x.coCount || y.rate - x.rate);
  return rows.slice(0, COUPLING_TOP);
}

function ownership(commits) {
  const byFile = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      if (!SOURCE_EXT.test(f.path)) continue;
      if (!byFile.has(f.path)) byFile.set(f.path, new Map());
      const authors = byFile.get(f.path);
      authors.set(c.author, (authors.get(c.author) || 0) + 1);
    }
  }
  const concentration = [];
  const spread = [];
  for (const [path, authors] of byFile) {
    const loc = lineCount(path);
    if (loc === 0) continue;
    let total = 0;
    let topAuthor = null;
    let topCount = 0;
    for (const [author, count] of authors) {
      total += count;
      if (count > topCount) {
        topCount = count;
        topAuthor = author;
      }
    }
    if (total < CONCENTRATION_MIN_COMMITS) continue;
    const share = topCount / total;
    if (share >= CONCENTRATION_SHARE) {
      concentration.push({ path, topAuthor, share, total, loc });
    }
    if (authors.size >= SPREAD_MIN_AUTHORS) {
      spread.push({ path, authors: authors.size, total, loc });
    }
  }
  concentration.sort((a, b) => b.loc * b.share - a.loc * a.share);
  spread.sort((a, b) => b.authors - a.authors || b.loc - a.loc);
  return {
    concentration: concentration.slice(0, 10),
    spread: spread.slice(0, 10),
  };
}

function weeklyDelta(commits) {
  const now = Date.now();
  const thisWeekStart = now - 7 * 86_400_000;
  const lastWeekStart = now - 14 * 86_400_000;
  const inRange = (c, lo, hi) =>
    Date.parse(c.isoDate) >= lo && Date.parse(c.isoDate) < hi;
  const top = (cmts) => {
    const counts = new Map();
    for (const c of cmts) {
      for (const f of c.files) {
        if (!SOURCE_EXT.test(f.path)) continue;
        counts.set(f.path, (counts.get(f.path) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, c]) => ({ path, commits: c }));
  };
  const thisTop = top(commits.filter((c) => inRange(c, thisWeekStart, now)));
  const lastTop = top(
    commits.filter((c) => inRange(c, lastWeekStart, thisWeekStart)),
  );
  const lastSet = new Set(lastTop.map((r) => r.path));
  for (const r of thisTop) r.isNew = !lastSet.has(r.path);
  return { thisTop, lastTop };
}

export function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\r\n|\n|\r/g, "<br>")
    .replaceAll("|", "\\|");
}

export function fmtRow(cols) {
  return `| ${cols.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function render(report) {
  const out = [];
  out.push("# Code Health History");
  out.push("");
  out.push(`_Generated ${report.generatedAt} from \`git log --numstat\`._`);
  out.push("");
  out.push(
    "CodeScene-style signals derived from git history. Strictly advisory; no merge gating.",
  );
  out.push("");
  out.push(
    "**Reading guide**: large + frequently-changed files (hotspots) are the highest-leverage refactor targets. Strongly coupled pairs hint at a missing abstraction. Single-owner files are bus-factor risk; many-author files are consensus-drift risk.",
  );
  out.push("");
  out.push("");

  // Hotspots
  out.push(
    `## Top ${HOTSPOT_TOP} hotspots (${WINDOW_HOTSPOT_DAYS}-day churn × current LOC)`,
  );
  out.push("");
  if (report.hotspots.length === 0) {
    out.push("_No source-file commits in the window._");
  } else {
    out.push(fmtRow(["#", "Score", "Commits", "LOC", "File"]));
    out.push(fmtRow(["---:", "---:", "---:", "---:", "---"]));
    report.hotspots.forEach((row, i) => {
      out.push(
        fmtRow([
          i + 1,
          row.score.toLocaleString("en-US"),
          row.commits,
          row.loc,
          `\`${row.path}\``,
        ]),
      );
    });
  }
  out.push("");

  // Coupling
  out.push(
    `## Top ${COUPLING_TOP} change-coupled file pairs (${WINDOW_LONG_DAYS}d)`,
  );
  out.push("");
  out.push(
    `Filters: co-changes ≥ ${COUPLING_MIN_COCHANGE}, co-change rate ≥ ${COUPLING_MIN_RATE * 100}%.`,
  );
  out.push("");
  if (report.coupling.length === 0) {
    out.push("_No file pairs above the threshold._");
  } else {
    out.push(fmtRow(["#", "Co-changes", "Rate", "File A", "File B"]));
    out.push(fmtRow(["---:", "---:", "---:", "---", "---"]));
    report.coupling.forEach((row, i) => {
      out.push(
        fmtRow([
          i + 1,
          row.coCount,
          `${(row.rate * 100).toFixed(0)}%`,
          `\`${row.a}\``,
          `\`${row.b}\``,
        ]),
      );
    });
  }
  out.push("");

  // Concentration
  out.push(
    `## Knowledge concentration (${WINDOW_LONG_DAYS}d, top author has ≥${CONCENTRATION_SHARE * 100}% of commits)`,
  );
  out.push("");
  if (report.ownership.concentration.length === 0) {
    out.push("_None._");
  } else {
    out.push(fmtRow(["#", "Share", "Commits", "LOC", "Top author", "File"]));
    out.push(fmtRow(["---:", "---:", "---:", "---:", "---", "---"]));
    report.ownership.concentration.forEach((row, i) => {
      out.push(
        fmtRow([
          i + 1,
          `${(row.share * 100).toFixed(0)}%`,
          row.total,
          row.loc,
          row.topAuthor,
          `\`${row.path}\``,
        ]),
      );
    });
  }
  out.push("");

  // Spread
  out.push(
    `## Knowledge spread (${WINDOW_LONG_DAYS}d, ≥${SPREAD_MIN_AUTHORS} distinct contributors)`,
  );
  out.push("");
  if (report.ownership.spread.length === 0) {
    out.push("_None._");
  } else {
    out.push(fmtRow(["#", "Authors", "Commits", "LOC", "File"]));
    out.push(fmtRow(["---:", "---:", "---:", "---:", "---"]));
    report.ownership.spread.forEach((row, i) => {
      out.push(
        fmtRow([i + 1, row.authors, row.total, row.loc, `\`${row.path}\``]),
      );
    });
  }
  out.push("");

  // Weekly delta
  out.push("## Weekly delta — top 5 hotspots this week");
  out.push("");
  out.push(
    "⭐ marks files that weren't in last week's top-5 (new emerging hotspots).",
  );
  out.push("");
  if (report.weekly.thisTop.length === 0) {
    out.push("_No source-file commits in the last 7 days._");
  } else {
    out.push(fmtRow(["#", "Commits", "Status", "File"]));
    out.push(fmtRow(["---:", "---:", ":---:", "---"]));
    report.weekly.thisTop.forEach((row, i) => {
      out.push(
        fmtRow([
          i + 1,
          row.commits,
          row.isNew ? "⭐ new" : "carry-over",
          `\`${row.path}\``,
        ]),
      );
    });
  }

  return out.join("\n") + "\n";
}

function main() {
  const commitsLong = parseLog(WINDOW_LONG_DAYS);
  const recent = Date.now() - WINDOW_HOTSPOT_DAYS * 86_400_000;
  const commitsHot = commitsLong.filter((c) => Date.parse(c.isoDate) >= recent);
  const report = {
    generatedAt: new Date().toISOString(),
    hotspots: topHotspots(commitsHot),
    coupling: changeCoupling(commitsLong),
    ownership: ownership(commitsLong),
    weekly: weeklyDelta(commitsLong),
  };
  const out = render(report);
  const outPath = join(REPO_ROOT, "reports", "code-health-history.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
  process.stdout.write(`✓ Wrote ${outPath}\n`);
  process.stdout.write(`  Hotspots: ${report.hotspots.length}\n`);
  process.stdout.write(`  Coupled pairs: ${report.coupling.length}\n`);
  process.stdout.write(
    `  Concentration risk: ${report.ownership.concentration.length}\n`,
  );
  process.stdout.write(`  Spread risk: ${report.ownership.spread.length}\n`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
