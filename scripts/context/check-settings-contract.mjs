/**
 * Contract assertions for the two agent-runtime configuration files:
 * `.claude/settings.json` and `.codex/hooks.json`.
 *
 * Two concerns live here, and both are security controls rather than
 * documentation policy:
 *
 * - the SessionEnd hook wiring for both runtimes, which must invoke
 *   `scripts/bootstrap/agent-session-end-hook.sh` through a derived repository
 *   root instead of a machine-local path;
 * - the verbatim copy of the `.claude/settings.json` Bash permission
 *   allowlist, which is an exact reviewed set so shell escaping or dynamic
 *   command construction cannot bypass a command-specific policy check.
 *
 * `check-agent-context.mjs` runs this module and folds the returned failures
 * into its own, so `pnpm agent:context-check` and the direct
 * `node scripts/context/check-agent-context.mjs` invocations in
 * `.github/workflows/supply-chain.yml` and the four bootstrap scripts keep
 * covering both halves. Like its caller this module stays on node builtins and
 * siblings only, so the weekly staleness job still runs with no `pnpm install`.
 *
 * Tests: scripts/context/check-settings-contract.test.mjs
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

function sessionEndCommands(settings, filePath, fail) {
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
    /&&\s+exec\s+bash\s+["']?\$repo\/scripts\/bootstrap\/agent-session-end-hook\.sh["']?/.test(
      command,
    )
  );
}

function isClaudeSessionEndCommand(command) {
  const scriptPath =
    /["']\$\{CLAUDE_PROJECT_DIR\}\/scripts\/bootstrap\/agent-session-end-hook\.sh["']/;
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

// Keep these in sync with `.claude/settings.json`. Bash permissions are an
// exact reviewed allowlist so shell escaping or dynamic command construction
// cannot bypass a command-specific policy check.
const allowedClaudeBashScriptPermissions = new Set([
  "Bash(bash scripts/agent-quality-gate.sh:*)",
  "Bash(bash ./scripts/agent-quality-gate.sh:*)",
  "Bash(bash scripts/agent-quality-gate.test.sh:*)",
  "Bash(bash ./scripts/agent-quality-gate.test.sh:*)",
  "Bash(bash scripts/bootstrap/agent-session-end-hook.sh:*)",
  "Bash(bash ./scripts/bootstrap/agent-session-end-hook.sh:*)",
  "Bash(node scripts/check-agent-quality-gate-package-scripts.mjs:*)",
  "Bash(node ./scripts/check-agent-quality-gate-package-scripts.mjs:*)",
  "Bash(bash ui-dashboard/scripts/check-react-doctor-diff.sh:*)",
  "Bash(bash ./ui-dashboard/scripts/check-react-doctor-diff.sh:*)",
  "Bash(bash ui-dashboard/scripts/check-react-doctor-score.sh:*)",
  "Bash(bash ./ui-dashboard/scripts/check-react-doctor-score.sh:*)",
]);

// Keep this in sync with `.claude/settings.json`. Exact entries make the key
// path part of the `sag` invocation itself; wrappers, compound commands, and
// comments cannot satisfy the check by mentioning the canonical path elsewhere.
const allowedClaudeSagPermissions = new Set([
  'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your feedback in the agent chat")',
  'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your approval in the agent chat")',
  'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, the task finished and needs your attention in the agent chat")',
]);

const allowedClaudeOtherBashPermissions = new Set([
  "Bash(terraform -chdir=terraform output:*)",
  "Bash(terraform -chdir=terraform plan:*)",
  "Bash(terraform -chdir=terraform validate:*)",
  'Bash(say "hey, i need your feedback in the agent chat")',
  'Bash(say "hey, i need your approval in the agent chat")',
  'Bash(say "hey, the task finished and needs your attention in the agent chat")',
  'Bash(spd-say "hey, i need your feedback in the agent chat")',
  'Bash(spd-say "hey, i need your approval in the agent chat")',
  'Bash(spd-say "hey, the task finished and needs your attention in the agent chat")',
  "Bash(ESLINT_BASELINE_MAIN=* node *)",
]);

const allowedClaudeBashPermissions = new Set([
  ...allowedClaudeBashScriptPermissions,
  ...allowedClaudeSagPermissions,
  ...allowedClaudeOtherBashPermissions,
]);

// Root `scripts/` and package-local `<package>/scripts/` both count: the React
// Doctor wrappers live in `ui-dashboard/scripts/`, so a prefix-blind check
// would route a package-local script permission into the generic branch.
const bashScriptPermission =
  /^Bash\(bash\s+(?:\.\/)?(?:[\w.-]+\/)?scripts\/[^)]*\)$/;
const bashDeployScriptPermission =
  /^Bash\(bash\s+(?:\.\/)?(?:[\w.-]+\/)?scripts\/deploy-[^)]*\)$/;

function isClaudeBashScriptPermission(permission) {
  return bashScriptPermission.test(permission);
}

function isClaudeSagPermission(permission) {
  if (!permission.startsWith("Bash(")) return false;

  const command = permission.slice(
    "Bash(".length,
    permission.endsWith(")") ? -1 : undefined,
  );
  const normalizedCommand = command
    .replace(/\\\r?\n/g, "")
    .replace(/[\\'"]/g, "");
  return /(?:^|[\s;&|()'"`$])(?:[^\s;&|()'"`$]+\/)?sag(?=$|[\s:;&|()'"`$])/.test(
    normalizedCommand,
  );
}

function validateClaudePermissions(settings, fail) {
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    fail(".claude/settings.json: expected permissions.allow array");
    return;
  }

  for (const permission of allow) {
    if (typeof permission !== "string") continue;
    if (!permission.startsWith("Bash(")) continue;

    if (
      isClaudeSagPermission(permission) &&
      !allowedClaudeSagPermissions.has(permission)
    ) {
      fail(
        `.claude/settings.json: sag permissions must include --api-key-file with the canonical ~/.config/elevenlabs_api_key path and match a reviewed single-command allowlist entry: ${permission}`,
      );
      continue;
    }

    if (/^Bash\(until\b/.test(permission)) {
      fail(
        `.claude/settings.json: permissions.allow must not allow shell-loop commands: ${permission}`,
      );
      continue;
    }

    if (allowedClaudeBashPermissions.has(permission)) continue;

    if (bashDeployScriptPermission.test(permission)) {
      fail(
        `.claude/settings.json: must not allow deploy/promote scripts: ${permission}`,
      );
    } else if (isClaudeBashScriptPermission(permission)) {
      fail(
        `.claude/settings.json: unexpected bash scripts allow: ${permission}`,
      );
    } else {
      fail(
        `.claude/settings.json: unexpected Bash permission; add the exact reviewed entry to the context-check allowlist: ${permission}`,
      );
    }
  }
}

/**
 * Assert the agent-runtime configuration contract against a repository tree.
 *
 * @param {{repoRoot: string, env?: NodeJS.ProcessEnv}} options
 * @returns {{failures: string[]}} failures in the order the caller reports them
 */
export function checkSettingsContract({ repoRoot, env = process.env }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const resolveInputPath = (filePath) =>
    path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);

  const exists = (filePath) => {
    try {
      statSync(resolveInputPath(filePath));
      return true;
    } catch {
      return false;
    }
  };

  const read = (filePath) => readFileSync(resolveInputPath(filePath), "utf8");

  const readRequired = (filePath, displayPath = filePath) => {
    if (!exists(filePath)) {
      fail(`${displayPath}: required guard input is missing`);
      return null;
    }
    return read(filePath);
  };

  const readJsonRequired = (filePath, displayPath = filePath) => {
    const content = readRequired(filePath, displayPath);
    if (content === null) return null;
    try {
      return JSON.parse(content);
    } catch (error) {
      fail(`${displayPath}: invalid JSON (${error.message})`);
      return null;
    }
  };

  const testOnlyInputPath = (environmentVariable, canonicalPath) => {
    const override = env[environmentVariable];
    if (!override) return canonicalPath;
    if (env.NODE_ENV !== "test") {
      fail(`${environmentVariable}: test-only override requires NODE_ENV=test`);
      return canonicalPath;
    }
    return override;
  };

  // Test-only input overrides let the regression suite mutate disposable
  // fixtures instead of tracked runtime configuration. Fail closed if an
  // override leaks into a normal invocation.
  const codexHooks = readJsonRequired(
    testOnlyInputPath("AGENT_CONTEXT_CODEX_HOOKS_FILE", ".codex/hooks.json"),
    ".codex/hooks.json",
  );
  if (codexHooks) {
    const commands = sessionEndCommands(codexHooks, ".codex/hooks.json", fail);
    if (commands.some((command) => command.includes("/Users/"))) {
      fail(".codex/hooks.json: Codex hook command must not use /Users paths");
    }
    if (!commands.some(isCodexSessionEndCommand)) {
      fail(
        ".codex/hooks.json: expected SessionEnd command to execute scripts/bootstrap/agent-session-end-hook.sh via resolved repo root",
      );
    }
  }

  const claudeSettings = readJsonRequired(
    testOnlyInputPath(
      "AGENT_CONTEXT_CLAUDE_SETTINGS_FILE",
      ".claude/settings.json",
    ),
    ".claude/settings.json",
  );
  if (claudeSettings) {
    validateClaudePermissions(claudeSettings, fail);

    const commands = sessionEndCommands(
      claudeSettings,
      ".claude/settings.json",
      fail,
    );
    if (commands.some((command) => command.includes("/Users/"))) {
      fail(
        ".claude/settings.json: Claude hook command must not use /Users paths",
      );
    }
    if (!commands.some(isClaudeSessionEndCommand)) {
      fail(
        ".claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh with bash",
      );
    }
  }

  const sessionEndHook = readRequired(
    "scripts/bootstrap/agent-session-end-hook.sh",
  );
  if (sessionEndHook?.includes("/Users/")) {
    fail(
      "scripts/bootstrap/agent-session-end-hook.sh: hook must derive the repository root instead of hardcoding a local path",
    );
  }

  return { failures };
}
