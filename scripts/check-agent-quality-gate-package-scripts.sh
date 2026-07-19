#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
const fs = require("node:fs");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = pkg.scripts ?? {};
const expectedScripts = {
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
  "adr:check": "node scripts/check-adr-reminder.mjs",
  "adr:check:test": "node scripts/check-adr-reminder.test.mjs",
  "agent:autoreview": "./scripts/agent-autoreview.sh",
  "issue:board": "node scripts/agent-issue-board.mjs",
  "issue:board:test": "node scripts/agent-issue-board.test.mjs",
  "issue:claim": "node scripts/agent-issue-board.mjs claim",
  "issue:review": "node scripts/agent-issue-board.mjs review",
  "issue:release": "node scripts/agent-issue-board.mjs release",
  "sentry:ingest": "node scripts/sentry-triage-ingest.mjs",
  "sentry:ingest:test": "node scripts/sentry-triage-ingest.test.mjs",
  "sentry:digest": "node scripts/sentry-triage-digest.mjs",
  "sentry:digest:test": "node scripts/sentry-triage-digest.test.mjs",
  "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
  "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
  "pr:ready-state": "node scripts/pr-ready-state.mjs",
  "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
  "tf": "node scripts/tf-stacks.mjs",
  "tf:test": "node scripts/tf-stacks.test.mjs",
  "alerts:rules:lint": "node scripts/alert-rules-lint.mjs",
  "alerts:rules:lint:test": "node scripts/alert-rules-lint.test.mjs",
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
NODE
