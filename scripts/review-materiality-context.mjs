import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { load as parseYaml } from "js-yaml";

import {
  classifyDocumentation,
  DOCUMENT_STATUSES,
  parseDocumentationMetadata,
} from "./docs-index-helpers.mjs";
import { assessStaleness, daysSince } from "./check-agent-context-helpers.mjs";

const REQUIRED_CANONICAL_NOTE_METADATA = [
  "title",
  "status",
  "owner",
  "last_verified",
  "doc_type",
  "scope",
  "review_interval_days",
  "garden_lane",
];

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function runGitQuiet(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function tryGit(args) {
  try {
    return runGit(args);
  } catch {
    return "";
  }
}

function tryGitQuiet(args) {
  try {
    return runGitQuiet(args);
  } catch {
    return "";
  }
}

function gitErrorMessage(error) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr?.toString?.().trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function diffSnapshot(effectiveBase, head) {
  const output = (format) =>
    runGit(["diff", format, "--no-renames", effectiveBase, head]);
  return {
    nameOnly: output("--name-only"),
    numstat: output("--numstat"),
  };
}

export function resolveDiffComparison(base, head) {
  try {
    const effectiveBase = runGit(["merge-base", base, head]).trim();
    if (!effectiveBase) {
      throw new Error(`no merge base for ${base} and ${head}`);
    }
    return { effectiveBase, head, ...diffSnapshot(effectiveBase, head) };
  } catch (tripleDotError) {
    try {
      const effectiveBase = runGit([
        "rev-parse",
        "--verify",
        `${base}^{commit}`,
      ]).trim();
      return { effectiveBase, head, ...diffSnapshot(effectiveBase, head) };
    } catch (twoDotError) {
      throw new Error(
        `unable to read git diff for ${base}..${head}: ${gitErrorMessage(twoDotError) || gitErrorMessage(tripleDotError)}`,
        { cause: twoDotError },
      );
    }
  }
}

export function resolveMetadataBase(base, head) {
  const mergeBase = tryGitQuiet(["merge-base", base, head]).trim();
  if (mergeBase) return mergeBase;

  return (
    tryGitQuiet(["rev-parse", "--verify", `${base}^{commit}`]).trim() || base
  );
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

export function changedPathsFromGit(comparison) {
  const outputs = [comparison.nameOnly];

  if (comparison.head === "HEAD") {
    outputs.push(
      tryGit(["diff", "--name-only", "--no-renames"]),
      tryGit(["diff", "--cached", "--name-only", "--no-renames"]),
      tryGit(["ls-files", "--others", "--exclude-standard"]),
    );
  }

  return uniqueSorted(
    outputs
      .join("\n")
      .split("\n")
      .map((line) => line.trim()),
  );
}

export function changedPathsFromFile(filePath) {
  const output = readFileSync(filePath, "utf8");
  return uniqueSorted(output.split("\n").map((line) => line.trim()));
}

function isSafeWorktreeRegularFile(filePath) {
  if (!filePath || isAbsolute(filePath)) return false;

  try {
    const root = process.cwd();
    const absolute = resolve(root, filePath);
    const relativePath = relative(root, absolute);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }

    let current = root;
    let entry;
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      entry = lstatSync(current);
      if (entry.isSymbolicLink()) return false;
    }
    return entry?.isFile() === true;
  } catch {
    return false;
  }
}

function readWorktreeTextFile(filePath) {
  if (!isSafeWorktreeRegularFile(filePath)) {
    throw new Error(`not a regular worktree file: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function addNumstatOutput(stats, output) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [rawAdditions, rawDeletions, filePath] = line.split("\t");
    const additions = Number.parseInt(rawAdditions, 10);
    const deletions = Number.parseInt(rawDeletions, 10);
    const previous = stats.get(filePath) ?? { additions: 0, deletions: 0 };
    stats.set(filePath, {
      additions:
        previous.additions + (Number.isFinite(additions) ? additions : 0),
      deletions:
        previous.deletions + (Number.isFinite(deletions) ? deletions : 0),
    });
  }
}

function countTextLines(contents) {
  if (contents.length === 0) return 0;
  const newlineCount = contents.split("\n").length - 1;
  return contents.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function addUntrackedStats(stats, paths) {
  for (const filePath of paths) {
    if (stats.has(filePath)) continue;
    let additions;
    try {
      additions = countTextLines(readWorktreeTextFile(filePath));
    } catch {
      additions = 0;
    }
    stats.set(filePath, { additions, deletions: 0 });
  }
}

export function numstatFromGit(comparison) {
  const stats = new Map();
  addNumstatOutput(stats, comparison.numstat);

  if (comparison.head === "HEAD") {
    addNumstatOutput(stats, tryGit(["diff", "--numstat", "--no-renames"]));
    addNumstatOutput(
      stats,
      tryGit(["diff", "--cached", "--numstat", "--no-renames"]),
    );
    addUntrackedStats(
      stats,
      tryGit(["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  return stats;
}

function readTextAtRef(ref, filePath) {
  return runGitQuiet(["show", `${ref}:${filePath}`]);
}

function readTextAtHead(ref, filePath) {
  return ref === "HEAD"
    ? readWorktreeTextFile(filePath)
    : readTextAtRef(ref, filePath);
}

function isRegularFileAtHead(ref, filePath) {
  if (ref === "HEAD") {
    return isSafeWorktreeRegularFile(filePath);
  }

  const entry = runGitQuiet(["ls-tree", "-z", ref, "--", filePath]);
  return entry.startsWith("100644 blob ") || entry.startsWith("100755 blob ");
}

export function createContextSnapshotReaders({ base, head }) {
  return {
    readBaseContextFile: (filePath) => readTextAtRef(base, filePath),
    readHeadContextFile: (filePath) => readTextAtHead(head, filePath),
    isHeadContextFile: (filePath) => isRegularFileAtHead(head, filePath),
  };
}

function readJsonAtRef(ref, filePath) {
  if (ref === "HEAD") {
    try {
      return JSON.parse(readWorktreeTextFile(filePath));
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(runGit(["show", `${ref}:${filePath}`]));
  } catch {
    return null;
  }
}

export function rootScriptChanges(base, head) {
  const beforePackage = readJsonAtRef(base, "package.json");
  const afterPackage = readJsonAtRef(head, "package.json");
  if (beforePackage === null) {
    throw new Error(`unable to read package.json at ${base}`);
  }
  if (afterPackage === null) {
    throw new Error(`unable to read package.json at ${head}`);
  }

  const before = beforePackage.scripts ?? {};
  const after = afterPackage.scripts ?? {};
  const names = uniqueSorted([...Object.keys(before), ...Object.keys(after)]);

  return names
    .filter((name) => before[name] !== after[name])
    .map((name) => ({
      name,
      before: before[name] ?? null,
      after: after[name] ?? null,
      kind:
        before[name] === undefined
          ? "added"
          : after[name] === undefined
            ? "removed"
            : "changed",
    }));
}

export function isAgentRuntimeContextPath(filePath) {
  return (
    filePath === ".codex/hooks.json" || filePath === ".claude/settings.json"
  );
}

function isConventionBasedCanonicalContextPath(filePath) {
  return (
    filePath === "AGENTS.md" ||
    filePath.endsWith("/AGENTS.md") ||
    filePath === "CLAUDE.md" ||
    filePath.endsWith("/CLAUDE.md") ||
    filePath === "README.md" ||
    filePath === "docs/context-standards.md" ||
    filePath === "docs/deployment.md" ||
    filePath.startsWith("docs/pr-checklists/") ||
    filePath.startsWith(".agents/skills/") ||
    filePath.startsWith(".agents/roles/") ||
    filePath.startsWith(".claude/skills/") ||
    isAgentRuntimeContextPath(filePath)
  );
}

function parseFrontmatterDocument(content) {
  if (typeof content !== "string" || !content.startsWith("---\n")) {
    return null;
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const document = parseYaml(content.slice(4, end));
  return document && typeof document === "object" && !Array.isArray(document)
    ? document
    : null;
}

function isCanonicalNotePath(filePath) {
  return filePath.startsWith("docs/notes/") && filePath.endsWith(".md");
}

function readCanonicalNoteState(filePath, readContextFile) {
  if (!isCanonicalNotePath(filePath)) return null;

  try {
    // Canonical authority comes from the source marker itself. Catalog and
    // freshness validation decide whether head context is complete, but must
    // not downgrade review materiality for an authoritative base or head note.
    const content = readContextFile(filePath);
    const frontmatter = parseFrontmatterDocument(content);
    if (frontmatter?.canonical !== true && frontmatter?.canonical !== "true") {
      return null;
    }
    return { metadata: parseDocumentationMetadata(filePath, content) };
  } catch {
    return null;
  }
}

function hasValidCanonicalNoteMetadata(filePath, state) {
  const { metadata } = state;
  const verifiedAge = daysSince(metadata?.last_verified);
  return (
    metadata?.canonical === "true" &&
    DOCUMENT_STATUSES.includes(metadata.status) &&
    REQUIRED_CANONICAL_NOTE_METADATA.every((key) => metadata[key]?.trim()) &&
    classifyDocumentation(filePath, metadata).errors.length === 0 &&
    verifiedAge !== null &&
    assessStaleness(verifiedAge) === "ok"
  );
}

function isReadableContextPath(filePath, readContextFile) {
  try {
    readContextFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRegularHeadContextPath(filePath, isHeadContextFile) {
  try {
    return isHeadContextFile(filePath) === true;
  } catch {
    return false;
  }
}

export function resolveCanonicalContextPaths({
  paths,
  readBaseContextFile = (filePath) => readFileSync(filePath, "utf8"),
  readHeadContextFile = (filePath) => readFileSync(filePath, "utf8"),
  isHeadContextFile = () => true,
}) {
  const headCanonicalContextPaths = new Set();
  const materialityCanonicalContextPaths = new Set();

  for (const filePath of paths) {
    if (isConventionBasedCanonicalContextPath(filePath)) {
      materialityCanonicalContextPaths.add(filePath);
      if (
        isRegularHeadContextPath(filePath, isHeadContextFile) &&
        isReadableContextPath(filePath, readHeadContextFile)
      ) {
        headCanonicalContextPaths.add(filePath);
      }
      continue;
    }

    if (!isCanonicalNotePath(filePath)) continue;

    const regularHeadNote = isRegularHeadContextPath(
      filePath,
      isHeadContextFile,
    );
    const headNote = regularHeadNote
      ? readCanonicalNoteState(filePath, readHeadContextFile)
      : null;
    if (headNote) {
      materialityCanonicalContextPaths.add(filePath);
      if (hasValidCanonicalNoteMetadata(filePath, headNote)) {
        headCanonicalContextPaths.add(filePath);
      }
      continue;
    }

    if (!regularHeadNote) {
      materialityCanonicalContextPaths.add(filePath);
    }

    if (readCanonicalNoteState(filePath, readBaseContextFile)) {
      materialityCanonicalContextPaths.add(filePath);
    }
  }

  return { headCanonicalContextPaths, materialityCanonicalContextPaths };
}
