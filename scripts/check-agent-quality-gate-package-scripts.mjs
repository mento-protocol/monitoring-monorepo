#!/usr/bin/env node
import fs from "node:fs";

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
  // The routing table's own suite (ADR 0069). Since D5c retired the gate's bash
  // `case` arms the table IS the routing, and this suite is the only thing
  // proving that the pattern compiler agrees with bash, that no arm names a path
  // that has gone, that the engine implements the closed verb set, and that
  // `implementation_signature()` still lists every module the freshness stamp
  // must hash. The gate schedules it and so does the required `ci` job, which
  // makes it exactly the alias a PR weakening the routing would want to repoint.
  "gate:routing-table:test":
    'node --test "scripts/gate/routing-table/*.test.mjs"',
  "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
  "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
  "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
  "agent:review-materiality:test":
    "node scripts/pr/review-materiality.test.mjs",
  "agent:context-check": "node scripts/context/check-agent-context.mjs",
  "agent:context-budget": "node scripts/context/agent-context-budget.mjs",
  "agent:context-budget:test":
    "node scripts/context/agent-context-budget.test.mjs",
  "docs:index": "node scripts/context/docs-index.mjs",
  "docs:index:test": "node scripts/context/docs-index.test.mjs",
  "docs:audit": "node scripts/docs/docs-audit.mjs",
  "docs:audit:test": "node scripts/docs/docs-audit.test.mjs",
  "docs:garden": "node scripts/docs/docs-garden-issue.mjs",
  "docs:garden:test": "node scripts/docs/docs-garden-issue.test.mjs",
  "docs:navigation-eval": "node scripts/docs/docs-navigation-eval.mjs",
  "docs:navigation-eval:test":
    "node scripts/docs/docs-navigation-eval.test.mjs",
  "ci:contract:test":
    "node scripts/workflows/check-ci-contract.mjs && node --test scripts/workflows/check-ci-contract.test.mjs scripts/workflows/check-pr-validation-boundary.test.mjs scripts/workflows/check-workflow-permissions-drift.test.mjs",
  "adr:check": "node scripts/pr/check-adr-reminder.mjs",
  "adr:check:test": "node scripts/pr/check-adr-reminder.test.mjs",
  "agent:autoreview": "./scripts/agent-autoreview.sh",
  "agent:autoreview:test":
    "AUTOREVIEW_TEST_FOCUS=suite bash scripts/agent-autoreview.test.sh",
  "issue:board": "node scripts/pr/agent-issue-board.mjs",
  "issue:board:test": "node scripts/pr/agent-issue-board.test.mjs",
  "issue:claim": "node scripts/pr/agent-issue-board.mjs claim",
  "issue:review": "node scripts/pr/agent-issue-board.mjs review",
  "issue:release": "node scripts/pr/agent-issue-board.mjs release",
  "sentry:ingest": "node scripts/sentry/triage/sentry-triage-ingest.mjs",
  "sentry:ingest:test":
    "node scripts/sentry/triage/sentry-triage-ingest.test.mjs",
  "sentry:digest": "node scripts/sentry/triage/sentry-triage-digest.mjs",
  "sentry:digest:test":
    "node scripts/sentry/triage/sentry-triage-digest.test.mjs",
  "sentry:project": "node scripts/sentry/triage/sentry-triage-project.mjs",
  "sentry:project:test":
    "node scripts/sentry/triage/sentry-triage-project.test.mjs",
  "sentry:brief": "node scripts/sentry/triage/sentry-triage-brief.mjs",
  "sentry:brief:test":
    "node scripts/sentry/triage/sentry-triage-brief.test.mjs",
  "sentry:autofix:select":
    "node scripts/sentry/autofix/sentry-autofix-select.mjs",
  "sentry:autofix:select:test":
    "node scripts/sentry/autofix/sentry-autofix-select.test.mjs",
  "sentry:autofix:finalize:test":
    "node scripts/sentry/autofix/sentry-autofix-finalize.test.mjs",
  "sentry:autofix:run-record:test":
    "node scripts/sentry/autofix/sentry-autofix-run-record.test.mjs",
  "sentry:archive": "node scripts/sentry/triage/sentry-triage-archive.mjs",
  "sentry:archive:test":
    "node scripts/sentry/triage/sentry-triage-archive.test.mjs",
  "sentry:broker:test":
    "node --test scripts/sentry/broker/sentry-mcp-broker.test.mjs",
  "sentry:requeue:test":
    "node scripts/sentry/triage/sentry-triage-requeue.test.mjs",
  "pr:feedback-state": "node scripts/pr/pr-feedback-state.mjs",
  "pr:feedback-state:test": "node scripts/pr/pr-feedback-state.test.mjs",
  "pr:ready-state": "node scripts/pr/pr-ready-state.mjs",
  "pr:ready-state:test": "node scripts/pr/pr-ready-state.test.mjs",
  // The only sanctioned merge path. Repointing this alias at a bare
  // `gh pr merge` would strip the interactive-human refusal, the ready-state
  // check, and the consent record in one line, so the alias is pinned with the
  // other trust-bearing ones.
  "pr:merge": "node scripts/pr/merge-pr.mjs",
  "pr:merge:test": "node scripts/pr/merge-pr.test.mjs",
  // The .coderabbit.yaml allowlist pin (ADR 0066). CodeRabbit reads that config
  // from the PR's own source branch, so the suite that pins it is exactly the
  // command a weakening PR would want to drift.
  "coderabbit:config:test": "node scripts/coderabbit-config.test.mjs",
  tf: "node scripts/tf-stacks.mjs",
  "tf:test": "node scripts/tf-stacks.test.mjs",
  // The ADR 0053 deploy-staging contract's own runner. `tf:test` imports it for
  // its side effects, so before this alias the largest suite in the tree could
  // only be run through the umbrella.
  "deploy-staging:test": "node scripts/deploy-staging-contract.test.mjs",
  "alerts:rules:lint": "node scripts/alerts/alert-rules-lint.mjs",
  "alerts:rules:lint:test": "node scripts/alerts/alert-rules-lint.test.mjs",
  "lockfile:lint": "node scripts/supply-chain/lockfile-lint.mjs",
  "lockfile:lint:test": "node scripts/supply-chain/lockfile-lint.test.mjs",
  "skew:check": "node scripts/supply-chain/version-skew-check.mjs",
  "skew:check:test": "node scripts/supply-chain/version-skew-check.test.mjs",
  "override:prune-report":
    "node scripts/supply-chain/override-prune-report.mjs",
  "override:prune-report:test":
    "node scripts/supply-chain/override-prune-report.test.mjs",
  "sanitize:test": "node scripts/sanitize-terraform-output.test.mjs",
};

for (const [name, expected] of Object.entries(expectedScripts)) {
  if (scripts[name] !== expected) {
    console.error(
      `package.json scripts.${name} must be ${JSON.stringify(expected)}`,
    );
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
      "scripts/check-agent-quality-gate-package-scripts.mjs with the other sanctioned hooks",
  );
  process.exitCode = 1;
}
