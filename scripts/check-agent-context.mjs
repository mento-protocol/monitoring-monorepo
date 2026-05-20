#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const failures = [];
const requiredMetadataKeys = ["title", "status", "owner", "canonical"];
const validStatuses = new Set(["active", "archived", "draft"]);

function fail(message) {
  failures.push(message);
}

function exists(filePath) {
  try {
    statSync(path.join(repoRoot, filePath));
    return true;
  } catch {
    return false;
  }
}

function read(filePath) {
  return readFileSync(path.join(repoRoot, filePath), "utf8");
}

function readRequired(filePath) {
  if (!exists(filePath)) {
    fail(`${filePath}: required guard input is missing`);
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

function walk(dir, predicate = () => true) {
  const root = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (
      rel.includes("node_modules") ||
      rel.includes(".next") ||
      rel.includes("coverage") ||
      rel.includes(".envio") ||
      rel.includes("generated")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...walk(rel, predicate));
    } else if (predicate(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function parseFrontmatter(filePath) {
  const content = read(filePath);
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  const data = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return data;
}

function requireMetadata(filePath) {
  const data = parseFrontmatter(filePath);
  if (!data) {
    fail(`${filePath}: missing YAML frontmatter`);
    return;
  }
  for (const key of requiredMetadataKeys) {
    if (!data[key]) fail(`${filePath}: missing frontmatter key '${key}'`);
  }
  if (data.status && !validStatuses.has(data.status)) {
    fail(`${filePath}: invalid status '${data.status}'`);
  }
  if (data.canonical && !["true", "false"].includes(data.canonical)) {
    fail(`${filePath}: canonical must be true or false`);
  }
  if (data.canonical === "true" && !data.last_verified) {
    fail(`${filePath}: canonical files require last_verified`);
  }
}

const scopedAgentDirs = [
  "aegis",
  "indexer-envio",
  "metrics-bridge",
  "shared-config",
  "terraform",
  "scripts",
  "ui-dashboard",
];

const managedContextFiles = [
  "AGENTS.md",
  ...scopedAgentDirs.map((dir) => `${dir}/AGENTS.md`),
  "docs/context-standards.md",
  "docs/pr-checklists/recurring-review-patterns.md",
  ...walk(".agents/skills", (file) => file.endsWith("/SKILL.md")),
  ...walk(".agents/roles", (file) => file.endsWith(".md")),
];

for (const file of managedContextFiles) {
  if (!exists(file)) {
    fail(`${file}: required managed context file is missing`);
  } else {
    requireMetadata(file);
  }
}

for (const dir of scopedAgentDirs) {
  if (!exists(`${dir}/AGENTS.md`)) {
    fail(`${dir}/AGENTS.md: missing scoped instructions`);
  }
}

for (const skill of walk(".agents/skills", (file) => !file.endsWith("/"))) {
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
if (metricsWorkflow?.includes('revision-suffix="${GITHUB_SHA::7}-')) {
  fail(
    ".github/workflows/metrics-bridge.yml: revision suffix must be prefixed with a lowercase letter",
  );
}

const bridgeDeploy = readRequired("scripts/deploy-bridge.sh");
if (bridgeDeploy?.includes('REVISION_SUFFIX="${TAG}-')) {
  fail(
    "scripts/deploy-bridge.sh: revision suffix must be prefixed with a lowercase letter",
  );
}

if (failures.length > 0) {
  console.error("Agent context check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Agent context check passed (${managedContextFiles.length} managed files).`,
);
