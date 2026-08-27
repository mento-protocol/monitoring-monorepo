#!/usr/bin/env node
/**
 * Unit tests for scripts/context/check-settings-contract.mjs.
 *
 * The module reads a repository tree but never exits the process, so these
 * tests drive it directly against disposable fixture trees and assert on the
 * returned failure list. `check-agent-context.test.mjs` keeps one end-to-end
 * test proving its entrypoint still surfaces these failures.
 *
 * Run: node scripts/context/check-settings-contract.test.mjs
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkSettingsContract } from "./check-settings-contract.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

const CLAUDE_SESSION_END_COMMAND =
  'bash "${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh"';
const CODEX_SESSION_END_COMMAND =
  "bash -lc 'repo=$(git rev-parse --show-toplevel) && exec bash \"$repo/scripts/bootstrap/agent-session-end-hook.sh\"'";

function sessionEndHooks(command) {
  return { SessionEnd: [{ hooks: [{ type: "command", command }] }] };
}

function writeFixtureFile(root, filePath, content) {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeFixtureJson(root, filePath, value) {
  writeFixtureFile(root, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build a disposable tree holding the three inputs the contract reads, run the
 * module against it, and return its failures.
 *
 * @param {{
 *   allow?: unknown,
 *   claudeSettings?: unknown,
 *   claudeSettingsRaw?: string,
 *   codexHooks?: unknown,
 *   codexHooksRaw?: string,
 *   hookScript?: string,
 *   omit?: string[],
 *   env?: Record<string, string>,
 * }} options
 */
function runContract(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "check-settings-contract-"));
  const omit = new Set(options.omit ?? []);
  try {
    if (!omit.has(".codex/hooks.json")) {
      if (options.codexHooksRaw !== undefined) {
        writeFixtureFile(root, ".codex/hooks.json", options.codexHooksRaw);
      } else {
        writeFixtureJson(
          root,
          ".codex/hooks.json",
          options.codexHooks ?? {
            hooks: sessionEndHooks(CODEX_SESSION_END_COMMAND),
          },
        );
      }
    }
    if (!omit.has(".claude/settings.json")) {
      if (options.claudeSettingsRaw !== undefined) {
        writeFixtureFile(
          root,
          ".claude/settings.json",
          options.claudeSettingsRaw,
        );
      } else {
        writeFixtureJson(
          root,
          ".claude/settings.json",
          options.claudeSettings ?? {
            permissions: { allow: options.allow ?? [] },
            hooks: sessionEndHooks(CLAUDE_SESSION_END_COMMAND),
          },
        );
      }
    }
    if (!omit.has("scripts/bootstrap/agent-session-end-hook.sh")) {
      writeFixtureFile(
        root,
        "scripts/bootstrap/agent-session-end-hook.sh",
        options.hookScript ?? "#!/usr/bin/env bash\n",
      );
    }
    return checkSettingsContract({ repoRoot: root, env: options.env ?? {} })
      .failures;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFailureContains(failures, expected) {
  assert(
    failures.some((failure) => failure.includes(expected)),
    `expected a failure containing ${JSON.stringify(expected)}, got ${JSON.stringify(failures)}`,
  );
}

function assertNoFailures(failures) {
  assert(
    failures.length === 0,
    `expected no failures, got ${JSON.stringify(failures)}`,
  );
}

// ── clean contract ────────────────────────────────────────────────────────────

console.log("\nclean contract");

test("a conforming tree produces no failures", () => {
  assertNoFailures(runContract());
});

test("accepts the presence-guarded Claude SessionEnd invocation", () => {
  const guarded =
    'if [ -f "${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh" ]; then bash "${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh"; fi';
  assertNoFailures(
    runContract({
      claudeSettings: {
        permissions: { allow: [] },
        hooks: sessionEndHooks(guarded),
      },
    }),
  );
});

// ── Claude Bash permission allowlist ──────────────────────────────────────────
//
// The allowlist is a security control: `.claude/settings.json` grants the
// permissions, and this module holds the reviewed copy. A one-sided edit to
// either must red, so every rejection branch gets a case here.

console.log("\nClaude Bash permission allowlist");

test("rejects direct and wrapped Claude sag permissions without the canonical key path", () => {
  const permissions = [
    'Bash(sag --api-key-file ~/.config/sag/elevenlabs-api-key -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(sag -v Charlie --api-key-file ~/.config/sag/elevenlabs-api-key "hey, i need your approval in the agent chat")',
    'Bash(sag speak --api-key-file ~/.config/sag/elevenlabs-api-key -v Charlie "hey, i need your approval in the agent chat")',
    "Bash(sag:*)",
    'Bash(env LANG=C sag --api-key-file ~/.config/other-key -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(command sag -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(echo ready && sag --api-key-file ~/.config/other-key -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(/usr/bin/env LANG=C /usr/local/bin/sag --api-key-file ~/.config/other-key -v Charlie "hey, i need your approval in the agent chat")',
    "Bash(command sag:*)",
    'Bash(env LANG=C command sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(command sag --api-key-file=~/.config/elevenlabs_api_key -v Charlie "hey, i need your approval in the agent chat")',
    'Bash(sag --api-key-file ~/.config/other-key -v Charlie "hey"; printf %s --api-key-file ~/.config/elevenlabs_api_key)',
    String.raw`Bash(s\ag --api-key-file /tmp/other-key -v Charlie "hey")`,
    "Bash(s''ag --api-key-file /tmp/other-key -v Charlie \"hey\")",
  ];

  for (const permission of permissions) {
    const failures = runContract({ allow: [permission] });
    assert(
      failures.some((failure) =>
        failure.includes(
          "sag permissions must include --api-key-file with the canonical ~/.config/elevenlabs_api_key path",
        ),
      ),
      `expected wrapped sag path failure for ${permission}, got ${JSON.stringify(failures)}`,
    );
  }
});

test("accepts the reviewed single-command Claude sag permissions", () => {
  assertNoFailures(
    runContract({
      allow: [
        'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your feedback in the agent chat")',
        'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your approval in the agent chat")',
        'Bash(sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, the task finished and needs your attention in the agent chat")',
      ],
    }),
  );
});

test("rejects every unreviewed Claude Bash permission", () => {
  const permissions = [
    "Bash(pnpm agent:quality-gate:*)",
    'Bash(cmd=sag; "$cmd" --api-key-file /tmp/other-key -v Charlie "hey")',
    "Bash(echo sagacious)",
  ];

  for (const permission of permissions) {
    const failures = runContract({ allow: [permission] });
    assert(
      failures.some((failure) =>
        failure.includes("unexpected Bash permission"),
      ),
      `expected unreviewed Bash permission failure for ${permission}, got ${JSON.stringify(failures)}`,
    );
  }
});

test("rejects shell-loop permissions", () => {
  assertFailureContains(
    runContract({ allow: ["Bash(until *)"] }),
    ".claude/settings.json: permissions.allow must not allow shell-loop commands: Bash(until *)",
  );
});

test("rejects unreviewed root and package-local bash script permissions", () => {
  for (const permission of [
    "Bash(bash scripts/*)",
    "Bash(bash ./scripts/*)",
    "Bash(bash scripts/agent-quality-gate.sh:*)",
    "Bash(bash ./scripts/agent-quality-gate.sh:*)",
    "Bash(bash ui-dashboard/scripts/check-react-doctor-other.sh:*)",
  ]) {
    assertFailureContains(
      runContract({ allow: [permission] }),
      `.claude/settings.json: unexpected bash scripts allow: ${permission}`,
    );
  }
});

test("rejects deploy and promote script permissions", () => {
  for (const permission of [
    // Both layouts. The wrappers live under `scripts/deploy/`; anchored on the
    // flat `scripts/deploy-` prefix alone, those entries fall to the generic
    // `scripts/` branch and still fail, but under a message that no longer says
    // "deploy". These cases pin the specific refusal, not merely a refusal.
    "Bash(bash ./scripts/deploy/deploy-dashboard.sh:*)",
    "Bash(bash scripts/deploy/deploy-indexer.sh:*)",
    "Bash(bash ./scripts/deploy/deploy-indexer-promote.sh:*)",
    // The flat half still has live subjects — the deploy-staging contract files
    // never moved — so it stays pinned against a real path, not a retired one.
    "Bash(bash ./scripts/deploy-staging-contract.mjs:*)",
    "Bash(bash ui-dashboard/scripts/deploy-preview.sh:*)",
  ]) {
    assertFailureContains(
      runContract({ allow: [permission] }),
      `.claude/settings.json: must not allow deploy/promote scripts: ${permission}`,
    );
  }
});

test("accepts every reviewed allowlist entry the settings file grants", () => {
  assertNoFailures(
    runContract({
      allow: [
        "Bash(./scripts/agent-quality-gate.sh:*)",
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
      ],
    }),
  );
});

// ── Claude WebFetch and unknown-kind policy ──────────────────────────────────
//
// Same control, other tool kinds. `WebFetch` gets its own reviewed set; every
// remaining kind fails closed, so granting one is a deliberate edit here rather
// than an entry that nothing grades.

console.log("\nClaude WebFetch and unknown-kind policy");

test("accepts the reviewed Claude WebFetch permission", () => {
  assertNoFailures(
    runContract({ allow: ["WebFetch(domain:monitoring.mento.org)"] }),
  );
});

test("rejects unreviewed Claude WebFetch permissions", () => {
  for (const permission of [
    "WebFetch(domain:example.com)",
    // Neighbours of the reviewed host on both sides of the label boundary: a
    // host-pattern check would have to rule on these, an exact set never sees
    // them as anything but absent.
    "WebFetch(domain:staging.monitoring.mento.org)",
    "WebFetch(domain:monitoring.mento.org.example.com)",
    "WebFetch(url:https://monitoring.mento.org/*)",
    "WebFetch(*)",
  ]) {
    assertFailureContains(
      runContract({ allow: [permission] }),
      `.claude/settings.json: unexpected WebFetch permission; add the exact reviewed entry to the context-check allowlist: ${permission}`,
    );
  }
});

test("rejects permission kinds that have no reviewed allowlist", () => {
  for (const permission of [
    "Read(docs/**)",
    "Edit(**)",
    "WebSearch",
    // A bare tool name is the widest grant of that tool. `Bash` without a
    // specifier must not slip past a check keyed on the `Bash(` prefix.
    "Bash",
    "mcp__github__create_pull_request",
    "",
  ]) {
    assertFailureContains(
      runContract({ allow: [permission] }),
      `.claude/settings.json: unreviewed permission kind; register it in scripts/context/check-settings-contract.mjs with its own reviewed allowlist before granting it: ${permission}`,
    );
  }
});

test("ignores non-string allow entries", () => {
  assertNoFailures(runContract({ allow: [7, null, { Bash: "*" }] }));
});

test("rejects a permissions.allow that is not an array", () => {
  assertFailureContains(
    runContract({
      claudeSettings: {
        permissions: { allow: "Bash(echo hi)" },
        hooks: sessionEndHooks(CLAUDE_SESSION_END_COMMAND),
      },
    }),
    ".claude/settings.json: expected permissions.allow array",
  );
});

// ── tracked settings file invariant ──────────────────────────────────────────
//
// The reviewed sets are a verbatim copy of a tracked file, so cases that retype
// entries only prove the copy agrees with itself. These read the real
// `.claude/settings.json` and grade what it actually grants. The Bash case is
// the standing invariant: widening the loop to other kinds must leave every
// existing Bash grant validating exactly as before.

console.log("\ntracked settings file invariant");

const trackedAllow = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../.claude/settings.json",
    ),
    "utf8",
  ),
).permissions.allow;

test("every Bash entry the tracked settings file grants still validates", () => {
  const bashEntries = trackedAllow.filter(
    (permission) =>
      typeof permission === "string" && permission.startsWith("Bash("),
  );
  assert(
    bashEntries.length > 0,
    "expected the tracked settings file to grant Bash permissions",
  );
  assertNoFailures(runContract({ allow: bashEntries }));
});

test("every entry the tracked settings file grants validates", () => {
  assertNoFailures(runContract({ allow: trackedAllow }));
});

// ── SessionEnd hook wiring ────────────────────────────────────────────────────

console.log("\nSessionEnd hook wiring");

test("rejects a Claude SessionEnd command that does not run the hook script", () => {
  assertFailureContains(
    runContract({
      claudeSettings: {
        permissions: { allow: [] },
        hooks: sessionEndHooks(
          "echo ${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh",
        ),
      },
    }),
    ".claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh with bash",
  );
});

test("rejects a Codex SessionEnd command that does not resolve the repo root", () => {
  assertFailureContains(
    runContract({
      codexHooks: {
        hooks: sessionEndHooks(
          "bash -lc 'echo git rev-parse --show-toplevel && echo scripts/bootstrap/agent-session-end-hook.sh'",
        ),
      },
    }),
    ".codex/hooks.json: expected SessionEnd command to execute scripts/bootstrap/agent-session-end-hook.sh via resolved repo root",
  );
});

test("rejects machine-local paths in either SessionEnd command", () => {
  assertFailureContains(
    runContract({
      claudeSettings: {
        permissions: { allow: [] },
        hooks: sessionEndHooks(
          'bash "/Users/someone/repo/scripts/bootstrap/agent-session-end-hook.sh"',
        ),
      },
    }),
    ".claude/settings.json: Claude hook command must not use /Users paths",
  );
  assertFailureContains(
    runContract({
      codexHooks: {
        hooks: sessionEndHooks(
          "bash -lc '/Users/someone/repo/scripts/bootstrap/agent-session-end-hook.sh'",
        ),
      },
    }),
    ".codex/hooks.json: Codex hook command must not use /Users paths",
  );
});

test("rejects a missing hooks.SessionEnd array in either runtime file", () => {
  assertFailureContains(
    runContract({ codexHooks: { hooks: {} } }),
    ".codex/hooks.json: expected hooks.SessionEnd array",
  );
  assertFailureContains(
    runContract({
      claudeSettings: { permissions: { allow: [] }, hooks: {} },
    }),
    ".claude/settings.json: expected hooks.SessionEnd array",
  );
});

test("rejects a hook script that hardcodes a machine-local repository root", () => {
  assertFailureContains(
    runContract({
      hookScript: "#!/usr/bin/env bash\ncd /Users/someone/repo || exit 1\n",
    }),
    "scripts/bootstrap/agent-session-end-hook.sh: hook must derive the repository root instead of hardcoding a local path",
  );
});

// ── guard inputs ──────────────────────────────────────────────────────────────

console.log("\nguard inputs");

test("rejects a missing guard input", () => {
  for (const file of [
    ".codex/hooks.json",
    ".claude/settings.json",
    "scripts/bootstrap/agent-session-end-hook.sh",
  ]) {
    assertFailureContains(
      runContract({ omit: [file] }),
      `${file}: required guard input is missing`,
    );
  }
});

test("rejects invalid JSON in either runtime file", () => {
  assertFailureContains(
    runContract({ codexHooksRaw: "" }),
    ".codex/hooks.json: invalid JSON",
  );
  assertFailureContains(
    runContract({ claudeSettingsRaw: "{" }),
    ".claude/settings.json: invalid JSON",
  );
});

test("test-only input overrides require NODE_ENV=test", () => {
  for (const variable of [
    "AGENT_CONTEXT_CODEX_HOOKS_FILE",
    "AGENT_CONTEXT_CLAUDE_SETTINGS_FILE",
  ]) {
    assertFailureContains(
      runContract({ env: { [variable]: "/nonexistent/fixture.json" } }),
      `${variable}: test-only override requires NODE_ENV=test`,
    );
  }
});

test("an unscoped override still reads the canonical path", () => {
  // Fail closed: the override is refused, so the contract keeps grading the
  // tracked file rather than the caller's fixture.
  const failures = runContract({
    allow: ["Bash(echo sagacious)"],
    env: { AGENT_CONTEXT_CLAUDE_SETTINGS_FILE: "/nonexistent/fixture.json" },
  });
  assertFailureContains(
    failures,
    "AGENT_CONTEXT_CLAUDE_SETTINGS_FILE: test-only override requires NODE_ENV=test",
  );
  assertFailureContains(failures, "unexpected Bash permission");
});

test("NODE_ENV=test honours a test-only override", () => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "check-settings-contract-override-"),
  );
  try {
    writeFixtureJson(fixtureRoot, "settings.json", {
      permissions: { allow: ["Bash(echo sagacious)"] },
      hooks: sessionEndHooks(CLAUDE_SESSION_END_COMMAND),
    });
    const failures = runContract({
      env: {
        NODE_ENV: "test",
        AGENT_CONTEXT_CLAUDE_SETTINGS_FILE: path.join(
          fixtureRoot,
          "settings.json",
        ),
      },
    });
    assertFailureContains(failures, "unexpected Bash permission");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
