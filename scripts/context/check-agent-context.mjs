#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  assessStaleness,
  daysSince,
  discoverCanonicalFiles,
  missingCoreContextFiles,
  parseFrontmatter,
  STALE_AFTER_DAYS,
} from "./check-agent-context-helpers.mjs";
import {
  DOCUMENT_TYPES,
  GARDEN_LANES,
  parseDocumentationMetadata,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";
import { loadClaudeRuntimeDocumentRegistry } from "./claude-runtime-document-registry.mjs";
import { checkSettingsContract } from "./check-settings-contract.mjs";

const repoRoot = process.cwd();
const failures = [];
const requiredMetadataKeys = ["title", "status", "owner", "canonical"];
const validStatuses = new Set(["active", "archived", "draft"]);
const readmeContextMarkerPattern = /<!--\s*agent-context:\s*([\s\S]*?)-->/i;

function fail(message) {
  failures.push(message);
}

function resolveInputPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function exists(filePath) {
  try {
    statSync(resolveInputPath(filePath));
    return true;
  } catch {
    return false;
  }
}

function read(filePath) {
  return readFileSync(resolveInputPath(filePath), "utf8");
}

function readRequired(filePath, displayPath = filePath) {
  if (!exists(filePath)) {
    fail(`${displayPath}: required guard input is missing`);
    return null;
  }
  return read(filePath);
}

function normalizeSkillContent(filePath, content) {
  if (!filePath.endsWith("forensic-report/SKILL.md")) return content;
  return content
    .replaceAll('source: "Codex"', 'source: "<agent-source>"')
    .replaceAll('source: "claude"', 'source: "<agent-source>"')
    .replaceAll('`source: "Codex"`', '`source: "<agent-source>"`')
    .replaceAll('`source: "claude"`', '`source: "<agent-source>"`')
    .replaceAll(
      'set `"Codex"` from this skill',
      'set `"<agent-source>"` from this skill',
    )
    .replaceAll(
      'set `"claude"` from this skill',
      'set `"<agent-source>"` from this skill',
    );
}

function hasExecutableLine(content, pattern) {
  return content
    .split("\n")
    .some(
      (line) =>
        line.trim() !== "" &&
        !line.trim().startsWith("#") &&
        pattern.test(line),
    );
}

function parseFieldList(raw) {
  const data = {};
  const fieldPattern = /([A-Za-z0-9_-]+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  for (const match of raw.matchAll(fieldPattern)) {
    data[match[1]] = (match[3] ?? match[4] ?? match[2]).trim();
  }
  return data;
}

function parseReadmeContextMarker(content) {
  const match = readmeContextMarkerPattern.exec(content);
  if (!match) return null;
  return parseFieldList(match[1]);
}

function parseContextMetadata(filePath, content) {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter) return frontmatter;
  if (path.posix.basename(filePath) === "README.md") {
    return parseReadmeContextMarker(content);
  }
  return null;
}

function trackedFiles(dir, predicate = () => true, { required = false } = {}) {
  if (required && !exists(dir)) {
    fail(`${dir}: expected directory is missing or unreadable (ENOENT)`);
    return [];
  }
  let output;
  try {
    output = execFileSync("git", ["ls-files", "--", dir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (error) {
    if (required) {
      fail(
        `${dir}: unable to list tracked files (${error.code ?? error.message})`,
      );
    }
    return [];
  }
  const files = output
    .split("\n")
    .filter(Boolean)
    // Model the proposed working tree, not only the Git index. A tracked file
    // deleted by the current change must leave the canonical-context set
    // before the deletion is staged.
    .filter((file) => exists(file))
    .filter(predicate);
  if (required && files.length === 0) {
    fail(`${dir}: expected tracked files`);
  }
  return files;
}

function requireMetadata(filePath) {
  const data = parseContextMetadata(filePath, read(filePath));
  if (!data) {
    fail(
      `${filePath}: missing context metadata${path.posix.basename(filePath) === "README.md" ? " (YAML frontmatter or hidden agent-context marker)" : ""}`,
    );
    return;
  }
  for (const key of requiredMetadataKeys) {
    if (!data[key]) fail(`${filePath}: missing metadata key '${key}'`);
  }
  if (data.status && !validStatuses.has(data.status)) {
    fail(`${filePath}: invalid status '${data.status}'`);
  }
  if (data.canonical && !["true", "false"].includes(data.canonical)) {
    fail(`${filePath}: canonical must be true or false`);
  }
  if (data.canonical === "true" && !data.last_verified) {
    fail(`${filePath}: canonical files require last_verified`);
  } else if (data.canonical === "true" && data.last_verified) {
    const age = daysSince(data.last_verified);
    if (age === null) {
      fail(
        `${filePath}: last_verified '${data.last_verified}' is not a valid YYYY-MM-DD date`,
      );
    } else {
      const staleness = assessStaleness(age);
      if (staleness === "future") {
        fail(
          `${filePath}: last_verified ${data.last_verified} is in the future`,
        );
      } else if (staleness === "stale") {
        fail(
          `${filePath}: last_verified ${data.last_verified} is ${age} days old, exceeds the ${STALE_AFTER_DAYS}-day policy window`,
        );
      }
    }
  }
}

const scopedAgentDirs = [
  "aegis",
  "alerts",
  "indexer-envio",
  "integration-probes",
  "metrics-bridge",
  "shared-config",
  "terraform",
  "scripts",
  "ui-dashboard",
];

const delegatedOperatingRuleNotes = [
  "docs/notes/agent-issue-workflow.md",
  "docs/notes/agent-quality-gate-mechanics.md",
  "docs/notes/codex-agent-skills.md",
  "docs/notes/codex-cloud-setup.md",
  "docs/notes/cross-protocol-context.md",
  "docs/notes/dashboard-verification.md",
  "docs/notes/liquity-monitoring-invariants.md",
  "docs/notes/pr-ready-state.md",
  "docs/notes/quick-commands.md",
  "docs/notes/spoken-attention-nudge.md",
  "docs/notes/worktree-and-web-setup.md",
];

const canonicalSkillFiles = trackedFiles(
  ".agents/skills",
  (file) => !file.endsWith("/"),
  { required: true },
);
const claudeSkillFiles = trackedFiles(
  ".claude/skills",
  (file) => !file.endsWith("/"),
  {
    required: true,
  },
);

// The enforced set is discovered, not hardcoded: every tracked markdown file
// in the discovery roots (see isCanonicalDiscoveryPath) whose frontmatter
// declares `canonical: true` gets full metadata + staleness enforcement, so
// new canonical files are picked up automatically. README files may use a
// hidden metadata marker instead of visible frontmatter, so they are enrolled
// with the same metadata parser used by requireMetadata.
const trackedRepoFiles = trackedFiles(".");
const claudeRuntimeRegistry = loadClaudeRuntimeDocumentRegistry({
  repoRoot,
  files: trackedDocumentationFiles(repoRoot),
  parseDocumentationMetadata,
  documentTypes: DOCUMENT_TYPES,
  gardenLanes: GARDEN_LANES,
});
for (const error of claudeRuntimeRegistry.errors) fail(error);
const managedContextFiles = discoverCanonicalFiles(trackedRepoFiles, (file) =>
  exists(file) ? read(file) : "",
);
for (const readme of trackedRepoFiles.filter(
  (file) => path.posix.basename(file) === "README.md",
)) {
  const readmeMetadata = parseContextMetadata(readme, read(readme));
  if (
    readmeMetadata?.canonical === "true" &&
    !managedContextFiles.includes(readme)
  ) {
    managedContextFiles.push(readme);
  }
}

// Minimum-presence assertion: these core files must always be discovered.
// Without this, stripping a core file's frontmatter (or its `canonical:
// true` flag) would silently drop it out of the discovered set instead of
// failing the check.
const coreContextFiles = [
  "AGENTS.md",
  "README.md",
  "SPEC.md",
  ...scopedAgentDirs.map((dir) => `${dir}/AGENTS.md`),
  "docs/context-standards.md",
  "docs/pr-checklists/indexer-handler-invariants.md",
  "docs/pr-checklists/recurring-review-patterns.md",
  // Root-delegated operating-rule notes are pinned because root AGENTS.md or
  // another canonical entry point sends agents there for current behavior.
  // Other docs/notes/* canonical notes remain discovery-managed; removing
  // their frontmatter is the legitimate demote-from-canonical operation.
  ...delegatedOperatingRuleNotes,
  ...canonicalSkillFiles.filter((file) => file.endsWith("/SKILL.md")),
  ...trackedFiles(".agents/roles", (file) => file.endsWith(".md"), {
    required: true,
  }),
];

for (const file of missingCoreContextFiles(
  coreContextFiles,
  managedContextFiles,
)) {
  if (!exists(file)) {
    fail(`${file}: required managed context file is missing`);
  } else {
    fail(
      `${file}: core context file must keep canonical: true metadata (discovery no longer finds it)`,
    );
  }
}

for (const file of managedContextFiles) {
  requireMetadata(file);
  if (read(file).includes("/Users/")) {
    fail(`${file}: managed context must not include /Users paths`);
  }
}

for (const dir of scopedAgentDirs) {
  if (!exists(`${dir}/AGENTS.md`)) {
    fail(`${dir}/AGENTS.md: missing scoped instructions`);
  }
}

for (const mirror of claudeSkillFiles) {
  const canonical = mirror.replace(/^\.claude\/skills\//, ".agents/skills/");
  if (!exists(canonical)) {
    fail(`${mirror}: extra mirror without canonical ${canonical}`);
  }
}

for (const skill of canonicalSkillFiles) {
  const mirror = skill.replace(/^\.agents\/skills\//, ".claude/skills/");
  if (!exists(mirror)) {
    fail(`${mirror}: missing mirror for canonical ${skill}`);
    continue;
  }
  const canonicalSkill = normalizeSkillContent(skill, read(skill));
  const mirrorSkill = normalizeSkillContent(mirror, read(mirror));
  if (canonicalSkill !== mirrorSkill) {
    fail(`${mirror}: differs from canonical ${skill}`);
  }
}

const metricsWorkflow = readRequired(".github/workflows/metrics-bridge.yml");
if (
  metricsWorkflow &&
  !hasExecutableLine(
    metricsWorkflow,
    /^\s*--revision-suffix="r-\$\{GITHUB_SHA::7\}-\$\{GITHUB_RUN_ID\}"\s*\\?\s*$/,
  )
) {
  fail(
    ".github/workflows/metrics-bridge.yml: expected Cloud Run revision suffix to use r-${GITHUB_SHA::7}-${GITHUB_RUN_ID}",
  );
}

const bridgeDeploy = readRequired("scripts/deploy/deploy-bridge.sh");
if (
  bridgeDeploy &&
  !hasExecutableLine(
    bridgeDeploy,
    /^\s*REVISION_SUFFIX="r-\$\{TAG\}-\$\(date \+%s\)"\s*$/,
  )
) {
  fail(
    "scripts/deploy/deploy-bridge.sh: expected Cloud Run revision suffix to use r-${TAG}-$(date +%s)",
  );
}

// The `.claude/settings.json` permission allowlist and the SessionEnd hook
// wiring for both runtimes are agent-runtime configuration, not documentation
// metadata. They live in their own module with their own suite; this
// entrypoint stays their only caller so `pnpm agent:context-check` and the
// direct `node scripts/context/check-agent-context.mjs` invocations keep
// covering both halves.
for (const failure of checkSettingsContract({ repoRoot }).failures) {
  fail(failure);
}

if (failures.length > 0) {
  console.error("Agent context check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Agent context check passed (${managedContextFiles.length} managed files).`,
);
