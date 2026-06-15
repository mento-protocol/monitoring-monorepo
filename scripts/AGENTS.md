---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Scripts

## Scope

`scripts/` contains deploy wrappers, agent quality gates, code-health checks, and repo maintenance utilities.

## Operating Rules

- Shell scripts use `set -euo pipefail`.
- Parse JSON with Node, jq, or structured tooling. Do not scrape JSON with grep or sed.
- Deploy scripts must refuse dirty working trees before mutating external systems.
- Do not add `--no-verify` to git commands. Local hooks encode repo policy.
- New deploy scripts must print the target, commit, and rollback or verification command before/after mutation.
- New root scripts must be covered by `pnpm lint:scripts` or a direct test command in `scripts/agent-quality-gate.sh`.

## Verification

Run `pnpm lint:scripts`, `bash -n scripts/<changed-script>.sh`, and `pnpm agent:quality-gate:test` when quality-gate routing changes.
For deploy-wrapper changes, also run `node scripts/check-deploy-root-anchors.test.mjs`.
