#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

import { parseDocumentationMetadata } from "./docs-index-helpers.mjs";

const TIER_ORDER = ["trivial", "standard", "full"];
const DEFAULT_BASE = "origin/main";
const DEFAULT_HEAD = "HEAD";
const FULL_LINE_CHANGE_THRESHOLD = 800;
const STANDARD_LINE_CHANGE_THRESHOLD = 200;
const FULL_FILE_COUNT_THRESHOLD = 25;
const STANDARD_FILE_COUNT_THRESHOLD = 8;
const REQUIRED_CANONICAL_NOTE_METADATA = [
  "title",
  "status",
  "owner",
  "last_verified",
];
const VALID_CONTEXT_STATUSES = new Set(["active", "archived", "draft"]);

function usage() {
  return `Usage: pnpm agent:review-materiality [options]

Classify the review depth and context-update risk for the current change.

Options:
  --base <ref>              Base ref. Default: ${DEFAULT_BASE}
  --head <ref>              Head ref. Default: ${DEFAULT_HEAD}
  --changed-paths-file <f>  Read changed paths from a newline-delimited file.
                            Line counts are unavailable in this mode.
  --json                    Emit JSON instead of human output.
  -h, --help                Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE,
    head: DEFAULT_HEAD,
    changedPathsFile: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base":
        args.base = argv[++index] ?? "";
        if (!args.base) throw new Error("--base requires a ref");
        break;
      case "--head":
        args.head = argv[++index] ?? "";
        if (!args.head) throw new Error("--head requires a ref");
        break;
      case "--changed-paths-file":
        args.changedPathsFile = argv[++index] ?? "";
        if (!args.changedPathsFile) {
          throw new Error("--changed-paths-file requires a file path");
        }
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function tryGit(args) {
  try {
    return runGit(args);
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

function resolveDiffComparison(base, head) {
  try {
    const effectiveBase = runGit(["merge-base", base, head]).trim();
    if (!effectiveBase)
      throw new Error(`no merge base for ${base} and ${head}`);
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

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function changedPathsFromGit(comparison) {
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

function changedPathsFromFile(filePath) {
  const output = readFileSync(filePath, "utf8");
  return uniqueSorted(output.split("\n").map((line) => line.trim()));
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
      additions = countTextLines(readFileSync(filePath, "utf8"));
    } catch {
      additions = 0;
    }
    stats.set(filePath, { additions, deletions: 0 });
  }
}

function numstatFromGit(comparison) {
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
  return runGit(["show", `${ref}:${filePath}`]);
}

function readTextAtHead(ref, filePath) {
  return ref === "HEAD"
    ? readFileSync(filePath, "utf8")
    : readTextAtRef(ref, filePath);
}

function readJsonAtRef(ref, filePath) {
  if (ref === "HEAD") {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
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

function rootScriptChanges(base, head) {
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

function tierMax(a, b) {
  return TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];
}

function signal(filePath, tier, reason) {
  return { path: filePath, tier, reason };
}

function isEnvExample(filePath) {
  return /(^|\/)\.env(?:\.[A-Za-z0-9_-]+)*\.example$/.test(filePath);
}

function isPackageManagerPath(filePath) {
  return (
    filePath === "package.json" ||
    filePath.endsWith("/package.json") ||
    filePath === "pnpm-lock.yaml" ||
    filePath.endsWith("/pnpm-lock.yaml") ||
    filePath === "pnpm-workspace.yaml" ||
    filePath.endsWith("/pnpm-workspace.yaml") ||
    filePath === ".npmrc" ||
    filePath.endsWith("/.npmrc") ||
    filePath === ".node-version" ||
    filePath.endsWith("/.node-version") ||
    filePath === "pnpmfile.cjs" ||
    filePath === ".pnpmfile.cjs" ||
    filePath.startsWith("patches/")
  );
}

function isAgentRuntimeContextPath(filePath) {
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

function hasCanonicalNoteMetadata(filePath, readContextFile) {
  if (!filePath.startsWith("docs/notes/") || !filePath.endsWith(".md")) {
    return false;
  }

  try {
    // The documentation catalog derives authority from this same metadata. Do
    // not fall back to its generated label: the catalog does not promote a
    // document, and it may be stale while the working tree is being edited.
    const content = readContextFile(filePath);
    const frontmatter = parseFrontmatterDocument(content);
    if (frontmatter?.canonical !== true && frontmatter?.canonical !== "true") {
      return false;
    }
    const metadata = parseDocumentationMetadata(filePath, content);
    return (
      metadata?.canonical === "true" &&
      VALID_CONTEXT_STATUSES.has(metadata.status) &&
      REQUIRED_CANONICAL_NOTE_METADATA.every((key) => metadata[key]?.trim())
    );
  } catch {
    // Deleted, unreadable, and malformed notes must not satisfy a required
    // context update merely because their path sits under docs/notes/.
    return false;
  }
}

function isCanonicalContextPath(filePath, readContextFile) {
  if (hasCanonicalNoteMetadata(filePath, readContextFile)) return true;
  if (!isConventionBasedCanonicalContextPath(filePath)) return false;

  try {
    readContextFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRepoToolingTestPath(filePath) {
  return (
    (filePath.startsWith("scripts/") || filePath.startsWith("tools/")) &&
    /\.test\.(?:cjs|js|mjs|sh|ts|tsx)$/.test(filePath)
  );
}

function classifyPath(filePath, canonicalContextPaths) {
  if (filePath.startsWith("docs/PLAN-")) {
    return signal(
      filePath,
      "trivial",
      "non-canonical planning or note document",
    );
  }

  if (isPackageManagerPath(filePath)) {
    return signal(filePath, "full", "package-manager or root command surface");
  }

  if (
    filePath.startsWith(".github/workflows/") ||
    filePath.startsWith(".github/actions/")
  ) {
    return signal(filePath, "full", "GitHub workflow or composite action");
  }

  if (
    filePath.startsWith("scripts/") ||
    filePath.startsWith("tools/") ||
    filePath === "turbo.json" ||
    filePath.startsWith(".trunk/")
  ) {
    return signal(filePath, "full", "agent, build, or repository tooling");
  }

  if (canonicalContextPaths.has(filePath)) {
    return signal(filePath, "full", "canonical agent or operator context");
  }

  if (filePath.startsWith("docs/notes/")) {
    return signal(
      filePath,
      "trivial",
      "non-canonical planning or note document",
    );
  }

  if (
    filePath.startsWith("terraform/") ||
    filePath.startsWith("alerts/infra/") ||
    filePath.startsWith("alerts/rules/") ||
    filePath.startsWith("aegis/terraform/") ||
    filePath.startsWith("aegis/grafana-agent/") ||
    filePath.startsWith("aegis/bin/") ||
    filePath === "aegis/app.yaml" ||
    filePath === "aegis/config.yaml" ||
    filePath.startsWith("governance-watchdog/infra/") ||
    filePath === "terraform.stacks.json" ||
    filePath === "cloudbuild.yaml" ||
    filePath === ".gcloudignore"
  ) {
    return signal(filePath, "full", "infrastructure, alerting, or deploy path");
  }

  if (
    filePath === "indexer-envio/schema.graphql" ||
    filePath.startsWith("indexer-envio/config.") ||
    filePath.startsWith("indexer-envio/src/handlers/") ||
    filePath === "indexer-envio/src/EventHandlers.ts" ||
    filePath === "indexer-envio/src/EventHandlersBridgeOnly.ts"
  ) {
    return signal(
      filePath,
      "full",
      "indexer schema, config, or handler data flow",
    );
  }

  if (
    filePath.startsWith("ui-dashboard/src/app/api/") ||
    filePath.startsWith("ui-dashboard/src/lib/") ||
    filePath.startsWith("ui-dashboard/src/hooks/")
  ) {
    return signal(
      filePath,
      "full",
      "dashboard API, GraphQL, polling, or UI state flow",
    );
  }

  if (filePath.startsWith("docs/") || filePath === "README.md") {
    return signal(filePath, "standard", "operator documentation");
  }

  if (
    filePath.includes("/src/") ||
    filePath.includes("/test/") ||
    filePath.includes("/tests/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx") ||
    filePath.endsWith(".test.mjs")
  ) {
    return signal(filePath, "standard", "source or test code");
  }

  return signal(filePath, "standard", "changed repository file");
}

function contextRequirementSignals(paths, scriptChanges) {
  const reasons = [];

  if (scriptChanges.length > 0) {
    reasons.push({
      kind: "root-package-script",
      detail: `root package scripts changed: ${scriptChanges.map((change) => change.name).join(", ")}`,
    });
  } else if (paths.includes("package.json")) {
    reasons.push({
      kind: "root-package-manifest",
      detail: "root package manifest changed",
    });
  }

  for (const filePath of paths) {
    if (
      (filePath.startsWith("scripts/") || filePath.startsWith("tools/")) &&
      !isRepoToolingTestPath(filePath)
    ) {
      reasons.push({
        kind: "repo-tooling",
        detail: `${filePath} changed`,
      });
    } else if (
      filePath.startsWith(".github/workflows/") ||
      filePath.startsWith(".github/actions/")
    ) {
      reasons.push({
        kind: "workflow",
        detail: `${filePath} changed`,
      });
    } else if (filePath !== "package.json" && isPackageManagerPath(filePath)) {
      reasons.push({
        kind: "package-manager",
        detail: `${filePath} changed`,
      });
    } else if (isEnvExample(filePath)) {
      reasons.push({
        kind: "env-example",
        detail: `${filePath} changed`,
      });
    } else if (isAgentRuntimeContextPath(filePath)) {
      reasons.push({
        kind: "agent-context",
        detail: `${filePath} changed`,
      });
    }
  }

  return reasons.filter(
    (reason, index, all) =>
      all.findIndex((candidate) => candidate.detail === reason.detail) ===
      index,
  );
}

function summarizeLineChanges(paths, numstat) {
  let additions = 0;
  let deletions = 0;

  for (const filePath of paths) {
    const stat = numstat.get(filePath);
    additions += stat?.additions ?? 0;
    deletions += stat?.deletions ?? 0;
  }

  return {
    additions,
    deletions,
    total: additions + deletions,
  };
}

function classifyBySize(fileCount, lineChanges) {
  if (
    fileCount >= FULL_FILE_COUNT_THRESHOLD ||
    lineChanges >= FULL_LINE_CHANGE_THRESHOLD
  ) {
    return signal(
      "__diff_size__",
      "full",
      `large diff (${fileCount} files, ${lineChanges} changed lines)`,
    );
  }

  if (
    fileCount >= STANDARD_FILE_COUNT_THRESHOLD ||
    lineChanges >= STANDARD_LINE_CHANGE_THRESHOLD
  ) {
    return signal(
      "__diff_size__",
      "standard",
      `moderate diff (${fileCount} files, ${lineChanges} changed lines)`,
    );
  }

  return null;
}

function recommendedReview(tier) {
  if (tier === "trivial") {
    return [
      "Run pnpm agent:quality-gate --run.",
      "Skip semantic autoreview unless the change is deceptively risky.",
    ];
  }

  if (tier === "standard") {
    return [
      "Run pnpm agent:quality-gate --run.",
      "Run pnpm agent:autoreview before pushing.",
    ];
  }

  return [
    "Run pnpm agent:quality-gate --run.",
    "Run pnpm agent:autoreview before pushing.",
    "Read any mapped checklist and audit sibling surfaces before the next push.",
  ];
}

export function analyzeMateriality({
  paths,
  numstat = new Map(),
  scriptChanges = [],
  readBaseContextFile = (filePath) => readFileSync(filePath, "utf8"),
  readHeadContextFile = (filePath) => readFileSync(filePath, "utf8"),
} = {}) {
  const changedPaths = uniqueSorted(paths ?? []);
  const headCanonicalContextPaths = new Set(
    changedPaths.filter((filePath) =>
      isCanonicalContextPath(filePath, readHeadContextFile),
    ),
  );
  const materialityCanonicalContextPaths = new Set([
    ...headCanonicalContextPaths,
    ...changedPaths.filter(isConventionBasedCanonicalContextPath),
  ]);
  for (const filePath of changedPaths) {
    if (
      !materialityCanonicalContextPaths.has(filePath) &&
      isCanonicalContextPath(filePath, readBaseContextFile)
    ) {
      materialityCanonicalContextPaths.add(filePath);
    }
  }
  const pathSignals = changedPaths.map((filePath) =>
    classifyPath(filePath, materialityCanonicalContextPaths),
  );
  const lineChanges = summarizeLineChanges(changedPaths, numstat);
  const sizeSignal = classifyBySize(changedPaths.length, lineChanges.total);
  const allSignals = sizeSignal ? [...pathSignals, sizeSignal] : pathSignals;
  const tier = allSignals.reduce(
    (current, item) => tierMax(current, item.tier),
    "trivial",
  );
  const contextReasons = contextRequirementSignals(changedPaths, scriptChanges);
  const contextUpdatesPresent = headCanonicalContextPaths.size > 0;
  const contextUpdateRequired = contextReasons.length > 0;

  return {
    tier,
    changedFileCount: changedPaths.length,
    lineChanges,
    contextUpdateRequired,
    contextUpdatesPresent,
    contextUpdateMissing: contextUpdateRequired && !contextUpdatesPresent,
    contextReasons,
    pathSignals: allSignals,
    rootScriptChanges: scriptChanges,
    recommendedReview: recommendedReview(tier),
  };
}

function renderHuman(report) {
  const lines = [
    `Review materiality: ${report.tier}`,
    `Changed files: ${report.changedFileCount}`,
    `Changed lines: +${report.lineChanges.additions} / -${report.lineChanges.deletions}`,
    `Context update: ${
      report.contextUpdateRequired
        ? report.contextUpdatesPresent
          ? "required and present"
          : "required but not present"
        : "not required"
    }`,
  ];

  if (report.contextReasons.length > 0) {
    lines.push("", "Context signals:");
    for (const reason of report.contextReasons) {
      lines.push(`- ${reason.detail}`);
    }
  }

  lines.push("", "Materiality signals:");
  for (const item of report.pathSignals) {
    lines.push(`- ${item.tier}: ${item.path} (${item.reason})`);
  }

  lines.push("", "Recommended review:");
  for (const item of report.recommendedReview) {
    lines.push(`- ${item}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const comparison = args.changedPathsFile
    ? null
    : resolveDiffComparison(args.base, args.head);
  const effectiveBase = comparison?.effectiveBase ?? args.base;
  const paths = args.changedPathsFile
    ? changedPathsFromFile(args.changedPathsFile)
    : changedPathsFromGit(comparison);
  const numstat = comparison ? numstatFromGit(comparison) : new Map();
  const scriptChanges = paths.includes("package.json")
    ? rootScriptChanges(effectiveBase, args.head)
    : [];
  const report = analyzeMateriality({
    paths,
    numstat,
    scriptChanges,
    readBaseContextFile: (filePath) => readTextAtRef(effectiveBase, filePath),
    readHeadContextFile: (filePath) => readTextAtHead(args.head, filePath),
  });

  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export { parseArgs, renderHuman };
