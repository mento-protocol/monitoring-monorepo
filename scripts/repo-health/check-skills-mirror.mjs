// Verifies that .agents/skills/ and .claude/skills/ are byte-for-byte
// identical. Docs and tooling reference both directories as an exact-mirror
// pair (see docs/notes/codex-agent-skills.md); this script is the enforcement
// for that contract. Exits nonzero and prints a drift report naming the
// differing files if the trees diverge, executable bits differ, either tree
// is missing, or either tree contains a symlink (byte comparison can't verify
// a symlink's target, so symlinks are rejected outright rather than silently
// trusted).
//
// One documented exception (docs/context-standards.md): runtime-specific
// provenance literals in the forensic-report skill — `source: "Codex"` in the
// canonical tree versus `source: "claude"` in the Claude mirror — are
// normalized before comparison, only inside forensic-report skill files.

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: node scripts/repo-health/check-skills-mirror.mjs

Verifies that .agents/skills/ and .claude/skills/ are byte-for-byte
identical. Docs and tooling reference both directories as an exact-mirror
pair (see docs/notes/codex-agent-skills.md); this script is the enforcement
for that contract. Exits nonzero and prints a drift report naming the
differing files if the trees diverge, executable bits differ, either tree
is missing, or either tree contains a symlink (byte comparison can't verify
a symlink's target, so symlinks are rejected outright rather than silently
trusted).

One documented exception (docs/context-standards.md): runtime-specific
provenance literals in the forensic-report skill — \`source: "Codex"\` in the
canonical tree versus \`source: "claude"\` in the Claude mirror — are
normalized before comparison, only inside forensic-report skill files.

Environment:
  SKILLS_MIRROR_ROOT_A  First tree to compare. Default: .agents/skills
  SKILLS_MIRROR_ROOT_B  Second tree to compare. Default: .claude/skills
`;

/**
 * Normalize the documented runtime-specific provenance literals
 * (docs/context-standards.md: forensic-report writes `source: "Codex"` in the
 * canonical skill and `source: "claude"` in the Claude mirror) so that ONLY
 * that documented difference, in forensic-report files only, is tolerated.
 */
export function normalizeProvenance(contents) {
  return contents.replace(
    /source: "(?:Codex|claude)"/g,
    'source: "__RUNTIME__"',
  );
}

/** The provenance exception applies only inside a forensic-report skill. */
export function isForensicReportPath(relativePath) {
  return (
    relativePath.startsWith("forensic-report/") ||
    relativePath.includes("/forensic-report/")
  );
}

function isDirectory(target) {
  try {
    // Follows symlinks, matching the shell predecessor's `[[ -d ]]`, so a
    // symlinked root reaches the symlink rejection below rather than being
    // reported as a missing directory.
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isSymbolicLink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Relative paths of every regular file under `root`, LC_ALL=C sorted. */
function listFiles(root) {
  const files = [];
  const walk = (relativeDir) => {
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  walk("");
  // Byte-wise ordering so drift reports are stable across locales, matching
  // the `LC_ALL=C sort` the shell predecessor used.
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every symlink at or under `root`, as display paths, LC_ALL=C sorted below the
 * root. The root itself counts: `find <root> -type l` reported a symlinked root
 * and never descended into it, and a symlinked root would otherwise let the
 * check validate content outside the declared tree.
 */
function listSymlinks(root) {
  if (isSymbolicLink(root)) return [root];
  const links = [];
  const walk = (relativeDir) => {
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) links.push(relative);
      // A symlinked directory is reported, never descended into.
      else if (entry.isDirectory()) walk(relative);
    }
  };
  walk("");
  return links
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((relative) => path.join(root, relative));
}

function isExecutable(target) {
  return (lstatSync(target).mode & 0o111) !== 0;
}

function sameContents(fileA, fileB, relativePath) {
  const a = readFileSync(fileA);
  const b = readFileSync(fileB);
  if (a.equals(b)) return true;
  if (!isForensicReportPath(relativePath)) return false;
  return (
    normalizeProvenance(a.toString("utf8")) ===
    normalizeProvenance(b.toString("utf8"))
  );
}

/**
 * Compare two mirrored trees.
 *
 * Returns `{ fatal, drift }`. `fatal` holds the abort conditions (a missing
 * tree, a symlink) that stop the comparison; `drift` holds per-file findings.
 */
export function compareMirrors(rootA, rootB) {
  const fatal = [];
  if (!isDirectory(rootA)) {
    fatal.push(`check-skills-mirror: missing directory: ${rootA}`);
  }
  if (!isDirectory(rootB)) {
    fatal.push(`check-skills-mirror: missing directory: ${rootB}`);
  }
  if (fatal.length > 0) return { fatal, drift: [] };

  const symlinks = [...listSymlinks(rootA), ...listSymlinks(rootB)];
  if (symlinks.length > 0) {
    fatal.push(
      "check-skills-mirror: symlinks are not supported in the mirrored trees (diff can't verify a symlink's target):",
      ...symlinks,
    );
    return { fatal, drift: [] };
  }

  const drift = [];
  const filesA = listFiles(rootA);
  const filesB = new Set(listFiles(rootB));

  // Content comparison, file-by-file, so the provenance exception and the
  // executable-bit check can both be applied per file.
  for (const relative of filesA) {
    const a = path.join(rootA, relative);
    const b = path.join(rootB, relative);
    if (!filesB.has(relative)) {
      drift.push(`only in ${rootA}: ${relative}`);
      continue;
    }
    if (!sameContents(a, b, relative)) {
      drift.push(
        isForensicReportPath(relative)
          ? `content drift (beyond documented provenance literals): ${relative}`
          : `content drift: ${relative}`,
      );
    }
    if (isExecutable(a) !== isExecutable(b)) {
      drift.push(`executable-bit drift: ${relative}`);
    }
  }

  const filesASet = new Set(filesA);
  for (const relative of filesB) {
    if (!filesASet.has(relative)) {
      drift.push(`only in ${rootB}: ${relative}`);
    }
  }

  return { fatal, drift };
}

function main(argv) {
  const [flag] = argv;
  if (flag === "-h" || flag === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flag !== undefined) {
    process.stderr.write(USAGE);
    return 1;
  }

  const rootA = process.env.SKILLS_MIRROR_ROOT_A ?? ".agents/skills";
  const rootB = process.env.SKILLS_MIRROR_ROOT_B ?? ".claude/skills";
  const { fatal, drift } = compareMirrors(rootA, rootB);

  if (fatal.length > 0) {
    process.stderr.write(`${fatal.join("\n")}\n`);
    return 1;
  }
  if (drift.length > 0) {
    process.stderr.write(
      `check-skills-mirror: ${rootA} and ${rootB} have drifted:\n`,
    );
    process.stderr.write(`${drift.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }

  process.stdout.write(
    `check-skills-mirror: ${rootA} and ${rootB} are identical\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = main(process.argv.slice(2));
}
