#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

function readJsonRequired(filePath) {
  const content = readRequired(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`${filePath}: invalid JSON (${error.message})`);
    return null;
  }
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
  const files = output.split("\n").filter(Boolean).filter(predicate);
  if (required && files.length === 0) {
    fail(`${dir}: expected tracked files`);
  }
  return files;
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

const managedContextFiles = [
  "AGENTS.md",
  ...scopedAgentDirs.map((dir) => `${dir}/AGENTS.md`),
  "docs/context-standards.md",
  "docs/pr-checklists/recurring-review-patterns.md",
  ...canonicalSkillFiles.filter((file) => file.endsWith("/SKILL.md")),
  ...trackedFiles(".agents/roles", (file) => file.endsWith(".md"), {
    required: true,
  }),
];

for (const file of managedContextFiles) {
  if (!exists(file)) {
    fail(`${file}: required managed context file is missing`);
  } else {
    requireMetadata(file);
    if (read(file).includes("/Users/")) {
      fail(`${file}: managed context must not include /Users paths`);
    }
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

const bridgeDeploy = readRequired("scripts/deploy-bridge.sh");
if (
  bridgeDeploy &&
  !hasExecutableLine(
    bridgeDeploy,
    /^\s*REVISION_SUFFIX="r-\$\{TAG\}-\$\(date \+%s\)"\s*$/,
  )
) {
  fail(
    "scripts/deploy-bridge.sh: expected Cloud Run revision suffix to use r-${TAG}-$(date +%s)",
  );
}

function sessionEndCommands(settings, filePath) {
  const entries = settings?.hooks?.SessionEnd;
  if (!Array.isArray(entries)) {
    fail(`${filePath}: expected hooks.SessionEnd array`);
    return [];
  }
  return entries.flatMap((entry) =>
    Array.isArray(entry?.hooks)
      ? entry.hooks
          .filter((hook) => hook?.type === "command")
          .map((hook) => hook.command)
          .filter((command) => typeof command === "string")
      : [],
  );
}

function isCodexSessionEndCommand(command) {
  return (
    /^bash\s+-lc\s+['"]/.test(command) &&
    command.includes("repo=$(git rev-parse --show-toplevel") &&
    /&&\s+exec\s+bash\s+["']?\$repo\/scripts\/agent-session-end-hook\.sh["']?/.test(
      command,
    )
  );
}

function isClaudeSessionEndCommand(command) {
  const scriptPath =
    /["']\$\{CLAUDE_PROJECT_DIR\}\/scripts\/agent-session-end-hook\.sh["']/;
  const directInvocation = new RegExp(
    String.raw`^bash\s+${scriptPath.source}(?:\s|$)`,
  );
  // Also accept a presence-guarded form: `if [ -f "${CLAUDE_PROJECT_DIR}/...sh" ]; then bash "${CLAUDE_PROJECT_DIR}/...sh"; fi`
  // This lets a Claude session that outlives a deleted worktree skip the hook silently
  // without swallowing real failures from the script when it does exist.
  const guardedInvocation = new RegExp(
    String.raw`^if\s+\[\s+-f\s+${scriptPath.source}\s+\]\s*;\s*then\s+bash\s+${scriptPath.source}\s*;\s*fi\s*$`,
  );
  return directInvocation.test(command) || guardedInvocation.test(command);
}

const allowedClaudeBashScriptPermissions = new Set([
  "Bash(bash scripts/agent-quality-gate.sh:*)",
  "Bash(bash ./scripts/agent-quality-gate.sh:*)",
  "Bash(bash scripts/agent-quality-gate.test.sh:*)",
  "Bash(bash ./scripts/agent-quality-gate.test.sh:*)",
  "Bash(bash scripts/agent-session-end-hook.sh:*)",
  "Bash(bash ./scripts/agent-session-end-hook.sh:*)",
  "Bash(bash scripts/check-agent-quality-gate-package-scripts.sh:*)",
  "Bash(bash ./scripts/check-agent-quality-gate-package-scripts.sh:*)",
  "Bash(bash scripts/check-react-doctor-diff.sh:*)",
  "Bash(bash ./scripts/check-react-doctor-diff.sh:*)",
  "Bash(bash scripts/check-react-doctor-score.sh:*)",
  "Bash(bash ./scripts/check-react-doctor-score.sh:*)",
]);

function isClaudeBashScriptPermission(permission) {
  return /^Bash\(bash\s+(?:\.\/)?scripts\/[^)]*\)$/.test(permission);
}

function validateClaudePermissions(settings) {
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    fail(".claude/settings.json: expected permissions.allow array");
    return;
  }

  for (const permission of allow) {
    if (typeof permission !== "string") continue;

    if (/^Bash\(until\b/.test(permission)) {
      fail(
        `.claude/settings.json: permissions.allow must not allow shell-loop commands: ${permission}`,
      );
    }

    if (!isClaudeBashScriptPermission(permission)) continue;

    if (!allowedClaudeBashScriptPermissions.has(permission)) {
      fail(
        `.claude/settings.json: unexpected bash scripts allow: ${permission}`,
      );
    }

    if (/^Bash\(bash\s+(?:\.\/)?scripts\/deploy-[^)]*\)$/.test(permission)) {
      fail(
        `.claude/settings.json: must not allow deploy/promote scripts: ${permission}`,
      );
    }
  }
}

const codexHooks = readJsonRequired(".codex/hooks.json");
if (codexHooks) {
  const commands = sessionEndCommands(codexHooks, ".codex/hooks.json");
  if (commands.some((command) => command.includes("/Users/"))) {
    fail(".codex/hooks.json: Codex hook command must not use /Users paths");
  }
  if (!commands.some(isCodexSessionEndCommand)) {
    fail(
      ".codex/hooks.json: expected SessionEnd command to execute scripts/agent-session-end-hook.sh via resolved repo root",
    );
  }
}

const claudeSettings = readJsonRequired(".claude/settings.json");
if (claudeSettings) {
  validateClaudePermissions(claudeSettings);

  const commands = sessionEndCommands(claudeSettings, ".claude/settings.json");
  if (commands.some((command) => command.includes("/Users/"))) {
    fail(
      ".claude/settings.json: Claude hook command must not use /Users paths",
    );
  }
  if (!commands.some(isClaudeSessionEndCommand)) {
    fail(
      ".claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/agent-session-end-hook.sh with bash",
    );
  }
}

const sessionEndHook = readRequired("scripts/agent-session-end-hook.sh");
if (sessionEndHook?.includes("/Users/")) {
  fail(
    "scripts/agent-session-end-hook.sh: hook must derive the repository root instead of hardcoding a local path",
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
