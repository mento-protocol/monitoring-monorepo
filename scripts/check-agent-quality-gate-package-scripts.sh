#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
const fs = require("node:fs");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = pkg.scripts ?? {};
const expectedScripts = {
  // The one sanctioned lifecycle hook. pnpm runs it during `pnpm install`, so
  // the scripts job (and every other install) executes it. Pinning its exact
  // command here means a mutation to something else — the truncate-the-suites
  // payload Codex 3754887736 describes — fails this validator; the hook-rejection
  // loop below rejects any OTHER lifecycle hook a package-only PR might add.
  postinstall: "pnpm --filter @mento-protocol/config build",
  "agent:quality-gate": "./scripts/agent-quality-gate.sh",
  "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
  "agent:prewarm": "node scripts/agent-prewarm.mjs",
  "agent:prewarm:test": "node scripts/agent-prewarm.test.mjs",
  "agent:review-materiality": "node scripts/review-materiality.mjs",
  "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
  "agent:context-check": "node scripts/check-agent-context.mjs",
  "agent:context-budget": "node scripts/agent-context-budget.mjs",
  "agent:context-budget:test": "node scripts/agent-context-budget.test.mjs",
  "docs:index": "node scripts/docs-index.mjs",
  "docs:index:test": "node scripts/docs-index.test.mjs",
  "docs:audit": "node scripts/docs-audit.mjs",
  "docs:audit:test": "node scripts/docs-audit.test.mjs",
  "docs:garden": "node scripts/docs-garden-issue.mjs",
  "docs:garden:test": "node scripts/docs-garden-issue.test.mjs",
  "docs:navigation-eval": "node scripts/docs-navigation-eval.mjs",
  "docs:navigation-eval:test": "node scripts/docs-navigation-eval.test.mjs",
  "adr:check": "node scripts/check-adr-reminder.mjs",
  "adr:check:test": "node scripts/check-adr-reminder.test.mjs",
  "agent:autoreview": "./scripts/agent-autoreview.sh",
  "agent:autoreview:test": "AUTOREVIEW_TEST_FOCUS=suite bash scripts/agent-autoreview.test.sh",
  "issue:board": "node scripts/agent-issue-board.mjs",
  "issue:board:test": "node scripts/agent-issue-board.test.mjs",
  "issue:claim": "node scripts/agent-issue-board.mjs claim",
  "issue:review": "node scripts/agent-issue-board.mjs review",
  "issue:release": "node scripts/agent-issue-board.mjs release",
  "sentry:ingest": "node scripts/sentry-triage-ingest.mjs",
  "sentry:ingest:test": "node scripts/sentry-triage-ingest.test.mjs",
  "sentry:digest": "node scripts/sentry-triage-digest.mjs",
  "sentry:digest:test": "node scripts/sentry-triage-digest.test.mjs",
  "sentry:project": "node scripts/sentry-triage-project.mjs",
  "sentry:project:test": "node scripts/sentry-triage-project.test.mjs",
  "sentry:brief": "node scripts/sentry-triage-brief.mjs",
  "sentry:brief:test": "node scripts/sentry-triage-brief.test.mjs",
  "sentry:autofix:select": "node scripts/sentry-autofix-select.mjs",
  "sentry:autofix:select:test": "node scripts/sentry-autofix-select.test.mjs",
  "sentry:autofix:finalize:test": "node scripts/sentry-autofix-finalize.test.mjs",
  "sentry:autofix:run-record:test": "node scripts/sentry-autofix-run-record.test.mjs",
  "sentry:archive": "node scripts/sentry-triage-archive.mjs",
  "sentry:archive:test": "node scripts/sentry-triage-archive.test.mjs",
  "sentry:broker:test": "node --test scripts/sentry-mcp-broker.test.mjs",
  "sentry:requeue:test": "node scripts/sentry-triage-requeue.test.mjs",
  "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
  "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
  "pr:ready-state": "node scripts/pr-ready-state.mjs",
  "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
  "tf": "node scripts/tf-stacks.mjs",
  "tf:test": "node scripts/tf-stacks.test.mjs",
  "alerts:rules:lint": "node scripts/alerts/alert-rules-lint.mjs",
  "alerts:rules:lint:test": "node scripts/alerts/alert-rules-lint.test.mjs",
  "lockfile:lint": "node scripts/lockfile-lint.mjs",
  "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
  "skew:check": "node scripts/version-skew-check.mjs",
  "skew:check:test": "node scripts/version-skew-check.test.mjs",
  "override:prune-report": "node scripts/override-prune-report.mjs",
  "override:prune-report:test": "node scripts/override-prune-report.test.mjs",
  "sanitize:test": "node scripts/sanitize-terraform-output.test.mjs",
};

for (const [name, expected] of Object.entries(expectedScripts)) {
  if (scripts[name] !== expected) {
    console.error(`package.json scripts.${name} must be ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  }
}

// Reject unsanctioned lifecycle hooks. `pnpm install` runs the install/publish
// hooks (preinstall, install, postinstall, prepare, prepublish[Only], pre/post
// pack); pnpm runs a `pre<x>`/`post<x>` hook automatically around any script
// `<x>` it invokes. Either kind runs trusted code the static coverage scan in
// check-sentry-suites-in-ci cannot see — a root `postinstall` that truncates the
// Sentry suites and this validator, or a `presentry:*:test` that empties a suite
// before its (now direct) CI step. The scripts job runs the validator BEFORE
// pnpm-install, so a hook a package-only PR adds is rejected here before install
// would execute it (Codex 3754887736). Only the exact hooks pinned in
// expectedScripts above are allowed; every other lifecycle-shaped script fails.
const INSTALL_PUBLISH_HOOKS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
]);
const scriptNames = new Set(Object.keys(scripts));
for (const [name, command] of Object.entries(scripts)) {
  let isHook = INSTALL_PUBLISH_HOOKS.has(name);
  if (!isHook) {
    // A `pre<x>`/`post<x>` hook auto-runs only when `<x>` is itself a script, so
    // this matches `presentry:ingest:test` (its `sentry:ingest:test` sibling
    // exists) without flagging an unrelated name like `agent:prewarm`.
    const affix = /^(pre|post)(.+)$/.exec(name);
    if (affix && scriptNames.has(affix[2])) isHook = true;
  }
  if (!isHook) continue;
  if (expectedScripts[name] === command) continue; // the sanctioned, pinned hook
  console.error(
    `package.json scripts.${name} is a lifecycle hook (${JSON.stringify(command)}) that runs ` +
      "automatically during install or around a trusted alias; remove it or pin it in " +
      "scripts/check-agent-quality-gate-package-scripts.sh with the other sanctioned hooks",
  );
  process.exitCode = 1;
}
NODE
