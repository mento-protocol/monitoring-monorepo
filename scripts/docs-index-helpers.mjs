import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { parseFrontmatter } from "./check-agent-context-helpers.mjs";

export const DOCS_INDEX_PATH = "docs/README.md";

export const GARDEN_LANES = [
  "agent-entry-points",
  "operator-runbooks",
  "pr-checklists-process",
  "adrs-architecture",
  "package-readmes-reference",
  "notes-plans-archive",
];

export const DOCUMENT_TYPES = [
  "adr",
  "agent-instructions",
  "checklist",
  "command",
  "index",
  "note",
  "plan",
  "prompt",
  "reference",
  "report",
  "role",
  "runbook",
  "skill",
  "tracker",
];

export const DOCUMENT_STATUSES = ["active", "archived", "draft"];

const README_CONTEXT_PATTERN = /<!--\s*agent-context:\s*([\s\S]*?)-->/i;
const PACKAGE_ROOTS = new Set([
  "aegis",
  "alerts",
  "governance-watchdog",
  "indexer-envio",
  "integration-probes",
  "metrics-bridge",
  "scripts",
  "shared-config",
  "terraform",
  "ui-dashboard",
]);

const OPERATOR_NAME_PATTERN =
  /(?:deploy|deployment|rollback|terraform|quick[_-]commands|webhook[_-]state|adding[_-]events|from[_-]scratch)/i;

function parseFieldList(raw) {
  const data = {};
  const fieldPattern = /([A-Za-z0-9_-]+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  for (const match of raw.matchAll(fieldPattern)) {
    data[match[1]] = (match[3] ?? match[4] ?? match[2]).trim();
  }
  return data;
}

export function parseDocumentationMetadata(file, content) {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter) return frontmatter;
  if (path.posix.basename(file) !== "README.md") return null;
  const marker = README_CONTEXT_PATTERN.exec(content);
  return marker ? parseFieldList(marker[1]) : null;
}

export function isDocumentationPath(file) {
  if (!file.endsWith(".md")) return false;
  if (path.posix.basename(file) === "CLAUDE.md") return false;
  if (file.startsWith(".claude/skills/")) return false;
  return true;
}

export function trackedDocumentationFiles(repoRoot) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.md",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const files = [
    ...new Set(
      output
        .split("\0")
        .filter(Boolean)
        .filter(isDocumentationPath)
        .filter((file) => existsSync(path.join(repoRoot, file))),
    ),
  ];
  if (
    existsSync(path.join(repoRoot, DOCS_INDEX_PATH)) &&
    !files.includes(DOCS_INDEX_PATH)
  ) {
    files.push(DOCS_INDEX_PATH);
  }
  return files.sort();
}

function firstHeading(content) {
  const withoutFrontmatter = content.startsWith("---\n")
    ? content.slice(content.indexOf("\n---\n", 4) + 5)
    : content;
  const match = /^#\s+(.+?)\s*$/m.exec(withoutFrontmatter);
  return match?.[1]?.replaceAll("`", "").trim() ?? null;
}

function normalizedBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function defaultScope(file) {
  const [root] = file.split("/");
  return PACKAGE_ROOTS.has(root) ? root : "repo-wide";
}

function classifyByPath(file, metadata) {
  const canonical = normalizedBoolean(metadata?.canonical);
  if (path.posix.basename(file) === "AGENTS.md") {
    return { docType: "agent-instructions", lane: "agent-entry-points" };
  }
  if (file.startsWith(".agents/skills/")) {
    return { docType: "skill", lane: "agent-entry-points" };
  }
  if (file.startsWith(".agents/roles/") || file.startsWith(".claude/agents/")) {
    return { docType: "role", lane: "agent-entry-points" };
  }
  if (file.startsWith(".claude/commands/")) {
    return { docType: "command", lane: "agent-entry-points" };
  }
  if (file.startsWith(".github/prompts/")) {
    return { docType: "prompt", lane: "agent-entry-points" };
  }
  if (file === ".claude/claude-security-guidance.md") {
    return { docType: "agent-instructions", lane: "agent-entry-points" };
  }
  if (file === ".github/PULL_REQUEST_TEMPLATE.md") {
    return { docType: "checklist", lane: "pr-checklists-process" };
  }
  if (file.startsWith("docs/adr/")) {
    return {
      docType: file === "docs/adr/README.md" ? "index" : "adr",
      lane: "adrs-architecture",
    };
  }
  if (file.startsWith("docs/pr-checklists/")) {
    return { docType: "checklist", lane: "pr-checklists-process" };
  }
  if (file === DOCS_INDEX_PATH) {
    return { docType: "index", lane: "package-readmes-reference" };
  }
  if (
    OPERATOR_NAME_PATTERN.test(file) ||
    (file.startsWith("docs/notes/") && canonical === true)
  ) {
    return { docType: "runbook", lane: "operator-runbooks" };
  }
  if (/^(?:docs\/)?(?:PLAN-|ROADMAP|BACKLOG)/i.test(file)) {
    return {
      docType: /BACKLOG/i.test(file) ? "tracker" : "plan",
      lane: "notes-plans-archive",
    };
  }
  if (file.startsWith("docs/notes/")) {
    return { docType: "note", lane: "notes-plans-archive" };
  }
  if (file.startsWith("reports/")) {
    return { docType: "report", lane: "notes-plans-archive" };
  }
  if (path.posix.basename(file) === "README.md" || file === "SPEC.md") {
    return { docType: "reference", lane: "package-readmes-reference" };
  }
  return { docType: "reference", lane: "package-readmes-reference" };
}

function defaultReviewInterval(docType, canonical) {
  if (canonical === true) return 90;
  if (
    ["agent-instructions", "checklist", "runbook", "skill", "adr"].includes(
      docType,
    )
  ) {
    return 90;
  }
  if (["reference", "command", "role", "prompt", "index"].includes(docType)) {
    return 180;
  }
  return 365;
}

export function classifyDocumentation(file, metadata = null) {
  const defaults = classifyByPath(file, metadata);
  const docType = metadata?.doc_type || defaults.docType;
  const lane = metadata?.garden_lane || defaults.lane;
  const canonical = normalizedBoolean(metadata?.canonical);
  const rawInterval = metadata?.review_interval_days;
  const reviewInterval = rawInterval
    ? Number(rawInterval.replaceAll("_", ""))
    : defaultReviewInterval(docType, canonical);
  const errors = [];
  if (!DOCUMENT_TYPES.includes(docType)) {
    errors.push(`${file}: invalid doc_type '${docType}'`);
  }
  if (!GARDEN_LANES.includes(lane)) {
    errors.push(`${file}: invalid garden_lane '${lane}'`);
  }
  if (!Number.isSafeInteger(reviewInterval) || reviewInterval <= 0) {
    errors.push(`${file}: review_interval_days must be a positive integer`);
  }
  return {
    doc_type: docType,
    garden_lane: lane,
    scope: metadata?.scope || defaultScope(file),
    review_interval_days: reviewInterval,
    errors,
  };
}

function stripNonProse(content) {
  return content
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
}

export function countWords(content) {
  const trimmed = content
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function extractMarkdownTargets(content) {
  const prose = stripNonProse(content);
  const targets = [];
  const inlinePattern =
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\s*\)/g;
  for (const match of prose.matchAll(inlinePattern))
    targets.push(match[1] ?? match[2]);
  const referencePattern = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const match of prose.matchAll(referencePattern))
    targets.push(match[1] ?? match[2]);
  return targets;
}

function ignoredTarget(target) {
  return (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(target) ||
    /[{}*]/.test(target)
  );
}

export function resolveMarkdownTarget(repoRoot, sourceFile, rawTarget) {
  if (ignoredTarget(rawTarget)) return { kind: "ignored" };
  const targetWithoutFragment = rawTarget.split("#", 1)[0].split("?", 1)[0];
  if (!targetWithoutFragment) return { kind: "ignored" };
  let decoded;
  try {
    decoded = decodeURIComponent(targetWithoutFragment);
  } catch {
    return {
      kind: "broken",
      target: rawTarget,
      reason: "invalid URL encoding",
    };
  }
  const absolute = path.resolve(repoRoot, path.dirname(sourceFile), decoded);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      kind: "broken",
      target: rawTarget,
      reason: "escapes repository root",
    };
  }
  if (!existsSync(absolute)) {
    return {
      kind: "broken",
      target: rawTarget,
      reason: "target does not exist",
    };
  }
  let resolved = absolute;
  if (statSync(absolute).isDirectory()) {
    const realDirectory = realpathSync(absolute);
    const realDirectoryRelative = path.relative(repoRoot, realDirectory);
    if (
      realDirectoryRelative.startsWith("..") ||
      path.isAbsolute(realDirectoryRelative)
    ) {
      return {
        kind: "broken",
        target: rawTarget,
        reason: "target resolves outside repository root",
      };
    }
    const readme = path.join(absolute, "README.md");
    if (!existsSync(readme)) return { kind: "valid", path: null };
    resolved = readme;
  }
  const realTarget = realpathSync(resolved);
  const realRelative = path.relative(repoRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    return {
      kind: "broken",
      target: rawTarget,
      reason: "target resolves outside repository root",
    };
  }
  const canonicalPath = realRelative.split(path.sep).join("/");
  return { kind: "valid", path: canonicalPath };
}

function lifecycle(metadata) {
  return metadata?.status || "unmanaged";
}

function authority(metadata) {
  const canonical = normalizedBoolean(metadata?.canonical);
  if (canonical === true) return "canonical";
  if (canonical === false) return "non-canonical";
  return "unmanaged";
}

function requiresManagedMetadata(file) {
  return (
    path.posix.basename(file) === "README.md" ||
    file === "docs/deployment.md" ||
    file.startsWith("docs/pr-checklists/")
  );
}

function requiredMetadataWarnings(file, metadata) {
  const warnings = [];
  if (!metadata && requiresManagedMetadata(file)) {
    return [`${file}: managed documentation surface is missing metadata`];
  }
  if (!metadata) return warnings;
  const contextKeys = [
    "canonical",
    "status",
    "owner",
    "last_verified",
    "doc_type",
    "scope",
    "review_interval_days",
    "garden_lane",
  ];
  const hasContextMetadata = contextKeys.some((key) => key in metadata);
  if (!hasContextMetadata && !requiresManagedMetadata(file)) return warnings;
  for (const key of ["title", "status", "owner", "canonical"]) {
    if (!metadata?.[key])
      warnings.push(`${file}: managed document is missing '${key}'`);
  }
  if (metadata.canonical && !["true", "false"].includes(metadata.canonical)) {
    warnings.push(`${file}: canonical must be true or false`);
  }
  if (metadata.status && !DOCUMENT_STATUSES.includes(metadata.status)) {
    warnings.push(`${file}: invalid status '${metadata.status}'`);
  }
  if (authority(metadata) === "canonical" && !metadata.last_verified) {
    warnings.push(`${file}: canonical document is missing 'last_verified'`);
  }
  if (authority(metadata) === "canonical") {
    for (const key of [
      "doc_type",
      "scope",
      "review_interval_days",
      "garden_lane",
    ]) {
      if (!metadata?.[key]) {
        warnings.push(`${file}: canonical document is missing '${key}'`);
      }
    }
  }
  return warnings;
}

export function buildDocumentationInventory({ repoRoot, files }) {
  const normalizedRoot = realpathSync(repoRoot);
  const records = [];
  const errors = [];
  const warnings = [];
  const inboundSources = new Map();
  const documentSet = new Set(files);
  const linksBySource = new Map();

  for (const file of files) {
    const absolute = path.join(normalizedRoot, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      errors.push(
        `${file}: tracked documentation file is missing or not a regular file`,
      );
      continue;
    }
    const content = readFileSync(absolute, "utf8");
    const metadata = parseDocumentationMetadata(file, content);
    const classification = classifyDocumentation(file, metadata);
    errors.push(...classification.errors);
    warnings.push(...requiredMetadataWarnings(file, metadata));
    records.push({
      path: file,
      title:
        metadata?.title || firstHeading(content) || path.posix.basename(file),
      authority: authority(metadata),
      canonical: normalizedBoolean(metadata?.canonical),
      status: lifecycle(metadata),
      owner: metadata?.owner || "unowned",
      last_verified: metadata?.last_verified || null,
      ...classification,
      words: countWords(content),
      bytes: Buffer.byteLength(content),
      inbound_links: 0,
    });
    linksBySource.set(file, extractMarkdownTargets(content));
  }

  const brokenLinks = [];
  for (const [source, targets] of linksBySource) {
    // The catalog is derived output. Its targets are guaranteed by the same
    // inventory that renders it, and stale links must not prevent --write from
    // repairing the generated file after a documentation deletion. Catalog
    // links also must not earn inbound credit: because the catalog enumerates
    // every document, counting those synthetic links would erase the useful
    // signal that no independently maintained document points at a record.
    if (source === DOCS_INDEX_PATH) continue;
    for (const target of targets) {
      const resolved = resolveMarkdownTarget(normalizedRoot, source, target);
      if (resolved.kind === "broken") {
        brokenLinks.push({ source, target, reason: resolved.reason });
      } else if (
        resolved.kind === "valid" &&
        resolved.path &&
        resolved.path !== source &&
        documentSet.has(resolved.path)
      ) {
        if (!inboundSources.has(resolved.path))
          inboundSources.set(resolved.path, new Set());
        inboundSources.get(resolved.path).add(source);
      }
    }
  }

  for (const record of records) {
    record.inbound_links = inboundSources.get(record.path)?.size ?? 0;
    delete record.errors;
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  brokenLinks.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target),
  );
  return {
    records,
    errors: [...new Set(errors)].sort(),
    warnings: [...new Set(warnings)].sort(),
    broken_links: brokenLinks,
  };
}

function escapeCell(value) {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function relativeCatalogLink(file) {
  const relative = path.posix.relative("docs", file) || "README.md";
  return relative
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29"),
    )
    .join("/");
}

function reviewCell(record) {
  const verified = record.last_verified
    ? `; verified ${record.last_verified}`
    : "";
  return `${record.review_interval_days}d${verified}`;
}

export function renderDocumentationIndex(
  inventory,
  { lastVerified = "2026-07-17" } = {},
) {
  const totalWords = inventory.records.reduce(
    (total, record) => total + record.words,
    0,
  );
  const authorityCounts = Object.fromEntries(
    ["canonical", "non-canonical", "unmanaged"].map((value) => [
      value,
      inventory.records.filter((record) => record.authority === value).length,
    ]),
  );
  const lines = [
    "---",
    "title: Documentation Catalog",
    "status: active",
    "owner: eng",
    "canonical: true",
    `last_verified: ${lastVerified}`,
    "doc_type: index",
    "scope: repo-wide",
    "review_interval_days: 90",
    "garden_lane: package-readmes-reference",
    "---",
    "",
    "# Documentation Catalog",
    "",
    "Generated by `pnpm docs:index --write`; verify drift with `pnpm docs:index --check`.",
    "This is the navigation index. A document's authority still comes from its metadata and",
    "the rules in [`context-standards.md`](context-standards.md).",
    "",
    `**${inventory.records.length} unique documents · ${totalWords.toLocaleString("en-US")} words · ${authorityCounts.canonical} canonical · ${authorityCounts["non-canonical"]} non-canonical · ${authorityCounts.unmanaged} unmanaged**`,
    "",
  ];

  for (const lane of GARDEN_LANES) {
    const records = inventory.records.filter(
      (record) => record.garden_lane === lane,
    );
    const words = records.reduce((total, record) => total + record.words, 0);
    lines.push(`## ${lane}`, "");
    lines.push(
      `${records.length} documents · ${words.toLocaleString("en-US")} words`,
      "",
    );
    lines.push(
      "| Document | Title | Authority | Type / scope | Owner | Review | Words / inbound |",
      "| --- | --- | --- | --- | --- | --- | ---: |",
    );
    for (const record of records) {
      const link = relativeCatalogLink(record.path);
      lines.push(
        `| [\`${escapeCell(record.path)}\`](${link}) | ${escapeCell(record.title)} | ${record.authority} / ${record.status} | ${record.doc_type} / ${record.scope} | ${escapeCell(record.owner)} | ${reviewCell(record)} | ${record.words.toLocaleString("en-US")} / ${record.inbound_links} |`,
      );
    }
    lines.push("");
  }

  if (inventory.warnings.length > 0) {
    lines.push("<details>", "<summary>Metadata warnings</summary>", "");
    for (const warning of inventory.warnings) lines.push(`- ${warning}`);
    lines.push("", "</details>", "");
  }
  if (inventory.broken_links.length > 0) {
    lines.push("## Broken internal links", "");
    for (const link of inventory.broken_links) {
      lines.push(`- \`${link.source}\` → \`${link.target}\` (${link.reason})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
