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
  "agent:context-check": "node scripts/check-agent-context.mjs",
  "agent:autoreview": "./scripts/agent-autoreview.sh",
  "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
  "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
  "pr:ready-state": "node scripts/pr-ready-state.mjs",
  "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
  "tf": "node scripts/tf-stacks.mjs",
  "tf:test": "node scripts/tf-stacks.test.mjs",
  "lockfile:lint": "node scripts/lockfile-lint.mjs",
  "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
  "skew:check": "node scripts/version-skew-check.mjs",
  "skew:check:test": "node scripts/version-skew-check.test.mjs",
};

for (const [name, expected] of Object.entries(expectedScripts)) {
  if (scripts[name] !== expected) {
    console.error(`package.json scripts.${name} must be ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  }
}
NODE
