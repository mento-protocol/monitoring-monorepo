import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

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

const REGISTRY_KEYS = new Set(["schema_version", "documents"]);
const DOCUMENT_KEYS = new Set([
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

function registryMetadataErrors({
  repoRoot,
  files,
  document,
  parseDocumentationMetadata,
  documentTypes,
  gardenLanes,
}) {
  const errors = [];
  for (const key of Object.keys(document ?? {})) {
    if (!DOCUMENT_KEYS.has(key)) {
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
  if (!documentTypes.includes(document?.doc_type)) {
    errors.push(
      registryError(
        `${document?.path ?? "entry"}: invalid doc_type '${document?.doc_type}'`,
      ),
    );
  }
  if (!gardenLanes.includes(document?.garden_lane)) {
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

export function loadClaudeRuntimeDocumentRegistry({
  repoRoot,
  files,
  parseDocumentationMetadata,
  documentTypes,
  gardenLanes,
}) {
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
    if (!REGISTRY_KEYS.has(key)) {
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
    errors.push(
      ...registryMetadataErrors({
        repoRoot,
        files,
        document,
        parseDocumentationMetadata,
        documentTypes,
        gardenLanes,
      }),
    );
    const runtimePath = document?.path;
    if (!isNonEmptyString(runtimePath)) continue;
    if (metadataByPath.has(runtimePath)) {
      errors.push(registryError(`${runtimePath}: duplicate runtime path`));
      continue;
    }
    metadataByPath.set(runtimePath, document);
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
