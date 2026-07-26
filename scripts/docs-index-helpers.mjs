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
export const CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH =
  "docs/claude-runtime-document-registry.json";
export const CLAUDE_RUNTIME_DOCUMENT_REGISTRY_VERSION =
  "claude-runtime-document-registry:v1";
export const CLAUDE_RUNTIME_DOCUMENT_PATHS = [
  ".claude/agents/dashboard-explorer.md",
  ".claude/agents/indexer-explorer.md",
  ".claude/agents/infra-reader.md",
  ".claude/commands/autoreview.md",
  ".claude/commands/babysit-indexer-deploy.md",
  ".claude/commands/verify-ui.md",
  ".claude/claude-security-guidance.md",
];

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
const CLAUDE_RUNTIME_REGISTRY_KEYS = new Set(["schema_version", "documents"]);
const CLAUDE_RUNTIME_DOCUMENT_KEYS = new Set([
  "path",
  "title",
  "status",
  "owner",
  "scope",
  "doc_type",
  "garden_lane",
  "canonical",
  "review_interval_days",
  "canonical_sources",
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
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function isClaudeRuntimeDocument(file) {
  return (
    file.startsWith(".claude/agents/") ||
    file.startsWith(".claude/commands/") ||
    file === ".claude/claude-security-guidance.md"
  );
}

function hasClaudeRuntimeDirectories(repoRoot) {
  return [".claude/agents", ".claude/commands"].some((directory) =>
    existsSync(path.join(repoRoot, directory)),
  );
}

function isSafeRepositoryPath(file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file)) return false;
  const normalized = path.posix.normalize(file);
  return normalized === file && !normalized.startsWith("../");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function proposedRepositoryFiles(repoRoot, candidates) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...candidates,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return new Set(output.split("\0").filter(Boolean));
}

function registryError(message) {
  return `${CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH}: ${message}`;
}

function registryMetadataErrors({ repoRoot, files, document }) {
  const errors = [];
  for (const key of Object.keys(document ?? {})) {
    if (!CLAUDE_RUNTIME_DOCUMENT_KEYS.has(key)) {
      errors.push(
        registryError(
          `${isNonEmptyString(document?.path) ? document.path : "entry"}: unknown key '${key}'`,
        ),
      );
    }
  }
  const stringFields = [
    "path",
    "title",
    "status",
    "owner",
    "scope",
    "doc_type",
    "garden_lane",
  ];
  for (const field of stringFields) {
    if (!isNonEmptyString(document?.[field])) {
      errors.push(
        registryError(
          `${isNonEmptyString(document?.path) ? document.path : "entry"}: '${field}' must be a non-empty string`,
        ),
      );
    }
  }
  for (const field of [
    "canonical",
    "review_interval_days",
    "canonical_sources",
  ]) {
    if (document?.[field] === undefined || document?.[field] === null) {
      errors.push(
        registryError(`${document?.path ?? "entry"}: missing '${field}'`),
      );
    }
  }
  if (!isSafeRepositoryPath(document?.path)) {
    errors.push(
      registryError(`${document?.path ?? "entry"}: invalid runtime path`),
    );
  }
  if (document?.canonical !== false) {
    errors.push(
      registryError(`${document?.path ?? "entry"}: canonical must be false`),
    );
  }
  if (document?.status !== "active") {
    errors.push(
      registryError(`${document?.path ?? "entry"}: status must be active`),
    );
  }
  if (!DOCUMENT_TYPES.includes(document?.doc_type)) {
    errors.push(
      registryError(
        `${document?.path ?? "entry"}: invalid doc_type '${document?.doc_type}'`,
      ),
    );
  }
  if (!GARDEN_LANES.includes(document?.garden_lane)) {
    errors.push(
      registryError(
        `${document?.path ?? "entry"}: invalid garden_lane '${document?.garden_lane}'`,
      ),
    );
  }
  if (
    !Number.isSafeInteger(document?.review_interval_days) ||
    document.review_interval_days <= 0
  ) {
    errors.push(
      registryError(
        `${document?.path ?? "entry"}: review_interval_days must be a positive integer`,
      ),
    );
  }
  if (
    !Array.isArray(document?.canonical_sources) ||
    !document.canonical_sources.length
  ) {
    errors.push(
      registryError(
        `${document?.path ?? "entry"}: canonical_sources must be non-empty`,
      ),
    );
  } else {
    for (const source of document.canonical_sources) {
      if (!isSafeRepositoryPath(source)) {
        errors.push(
          registryError(
            `${document.path}: invalid canonical source '${source}'`,
          ),
        );
        continue;
      }
      if (isClaudeRuntimeDocument(source)) {
        errors.push(
          registryError(
            `${document.path}: canonical source '${source}' is a Claude runtime projection`,
          ),
        );
        continue;
      }
      if (!files.includes(source)) {
        errors.push(
          registryError(
            `${document.path}: canonical source '${source}' is missing from the proposed tree`,
          ),
        );
        continue;
      }
      const sourcePath = path.join(repoRoot, source);
      if (!lstatSync(sourcePath).isFile()) {
        errors.push(
          registryError(
            `${document.path}: canonical source '${source}' is not a regular file`,
          ),
        );
        continue;
      }
      const sourceMetadata = parseDocumentationMetadata(
        source,
        readFileSync(sourcePath, "utf8"),
      );
      if (normalizedBoolean(sourceMetadata?.canonical) !== true) {
        errors.push(
          registryError(
            `${document.path}: canonical source '${source}' is not canonical`,
          ),
        );
      }
    }
  }
  return errors;
}

export function loadClaudeRuntimeDocumentRegistry({ repoRoot, files }) {
  const registryPath = path.join(
    repoRoot,
    CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
  );
  const requiresRegistry =
    files.some(isClaudeRuntimeDocument) ||
    hasClaudeRuntimeDirectories(repoRoot) ||
    existsSync(registryPath);
  if (!requiresRegistry) return { metadataByPath: new Map(), errors: [] };
  const proposedFiles = proposedRepositoryFiles(repoRoot, [
    CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
  ]);
  if (!proposedFiles.has(CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH)) {
    return {
      metadataByPath: new Map(),
      errors: [registryError("registry is missing from the proposed tree")],
    };
  }
  if (!existsSync(registryPath) || !lstatSync(registryPath).isFile()) {
    return {
      metadataByPath: new Map(),
      errors: [registryError("registry is not a regular file")],
    };
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    return {
      metadataByPath: new Map(),
      errors: [registryError(`invalid JSON (${error.message})`)],
    };
  }
  const errors = [];
  for (const key of Object.keys(registry ?? {})) {
    if (!CLAUDE_RUNTIME_REGISTRY_KEYS.has(key)) {
      errors.push(registryError(`unknown top-level key '${key}'`));
    }
  }
  if (registry?.schema_version !== CLAUDE_RUNTIME_DOCUMENT_REGISTRY_VERSION) {
    errors.push(
      registryError(
        `schema_version must be '${CLAUDE_RUNTIME_DOCUMENT_REGISTRY_VERSION}'`,
      ),
    );
  }
  if (!Array.isArray(registry?.documents)) {
    errors.push(registryError("documents must be an array"));
    return { metadataByPath: new Map(), errors };
  }

  const metadataByPath = new Map();
  for (const document of registry.documents) {
    if (metadataByPath.has(document?.path)) {
      errors.push(
        registryError(`${document?.path ?? "entry"}: duplicate runtime path`),
      );
      continue;
    }
    metadataByPath.set(document?.path, document);
    errors.push(...registryMetadataErrors({ repoRoot, files, document }));
  }
  const expected = new Set(CLAUDE_RUNTIME_DOCUMENT_PATHS);
  for (const expectedPath of CLAUDE_RUNTIME_DOCUMENT_PATHS) {
    if (!metadataByPath.has(expectedPath)) {
      errors.push(
        registryError(`missing required runtime path '${expectedPath}'`),
      );
    } else if (!files.includes(expectedPath)) {
      errors.push(
        registryError(
          `${expectedPath}: runtime document is missing from the proposed tree`,
        ),
      );
    } else {
      const runtimePath = path.join(repoRoot, expectedPath);
      if (!existsSync(runtimePath) || !lstatSync(runtimePath).isFile()) {
        errors.push(
          registryError(
            `${expectedPath}: runtime document is not a regular file`,
          ),
        );
      }
    }
  }
  for (const registeredPath of metadataByPath.keys()) {
    if (!expected.has(registeredPath)) {
      errors.push(registryError(`${registeredPath}: unexpected runtime path`));
    }
  }
  for (const file of files.filter(isClaudeRuntimeDocument)) {
    if (!metadataByPath.has(file)) {
      errors.push(
        registryError(`${file}: unregistered Claude runtime document`),
      );
    }
  }
  return {
    metadataByPath,
    errors: [...new Set(errors)].sort(),
  };
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
  const reviewInterval =
    rawInterval !== undefined && rawInterval !== null
      ? Number(String(rawInterval).replaceAll("_", ""))
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
    if (
      metadata?.[key] === undefined ||
      metadata?.[key] === null ||
      metadata?.[key] === ""
    )
      warnings.push(`${file}: managed document is missing '${key}'`);
  }
  if (
    metadata.canonical !== undefined &&
    metadata.canonical !== null &&
    normalizedBoolean(metadata.canonical) === null
  ) {
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
  const claudeRuntimeRegistry = loadClaudeRuntimeDocumentRegistry({
    repoRoot: normalizedRoot,
    files,
  });
  errors.push(...claudeRuntimeRegistry.errors);

  for (const file of files) {
    const absolute = path.join(normalizedRoot, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      errors.push(
        `${file}: tracked documentation file is missing or not a regular file`,
      );
      continue;
    }
    const content = readFileSync(absolute, "utf8");
    const metadata =
      claudeRuntimeRegistry.metadataByPath.get(file) ??
      parseDocumentationMetadata(file, content);
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
      canonical_sources: metadata?.canonical_sources || [],
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

function ownerCell(record) {
  const sources = (record.canonical_sources || [])
    .map(
      (source) => `[\`${escapeCell(source)}\`](${relativeCatalogLink(source)})`,
    )
    .join("; ");
  return sources
    ? `${escapeCell(record.owner)}; Sources: ${sources}`
    : escapeCell(record.owner);
}

export function renderDocumentationIndex(
  inventory,
  { lastVerified = "2026-07-17" } = {},
) {
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
  ];

  for (const lane of GARDEN_LANES) {
    const records = inventory.records.filter(
      (record) => record.garden_lane === lane,
    );
    lines.push(`## ${lane}`, "");
    lines.push(
      "| Document | Title | Authority | Type / scope | Owner | Review |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const record of records) {
      const link = relativeCatalogLink(record.path);
      lines.push(
        `| [\`${escapeCell(record.path)}\`](${link}) | ${escapeCell(record.title)} | ${record.authority} / ${record.status} | ${record.doc_type} / ${record.scope} | ${ownerCell(record)} | ${reviewCell(record)} |`,
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
