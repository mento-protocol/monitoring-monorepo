---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Scripts

> **Architecture decisions** behind these scripts live in [`docs/adr/`](../docs/adr/README.md) (scopes: `ci/process`, `terraform/infra`) — read the relevant ADR before changing how something here works; it records the _why_ the code can't.

## Scope

`scripts/` contains deploy wrappers, agent quality gates, code-health checks, and repo maintenance utilities.

## Operating Rules

- Shell scripts use `set -euo pipefail`.
- Parse JSON with Node, jq, or structured tooling. Do not scrape JSON with grep or sed.
- Compact/watch scripts must keep machine state and cadence metadata separate
  from human display strings. Gate emissions on stable fields, not volatile
  counters, block heights, or formatted progress lines.
- Deploy scripts must refuse dirty working trees before mutating external systems.
- Do not add `--no-verify` to git commands. Local hooks encode repo policy.
- New deploy scripts must print the target, commit, and rollback or verification command before/after mutation.
- New root scripts must be covered by `pnpm lint:scripts` or a direct test command in `scripts/agent-quality-gate.sh`.

## Verification

Run `pnpm lint:scripts`, `bash -n scripts/<changed-script>.sh`, and `pnpm agent:quality-gate:test` when quality-gate routing changes.
For deploy-wrapper changes, also run `node scripts/check-deploy-root-anchors.test.mjs`.
