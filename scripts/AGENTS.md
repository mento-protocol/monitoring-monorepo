---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-27
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

> **Architecture decisions** behind these scripts live in [`docs/adr/`](../docs/adr/README.md) — read the relevant ADR for the affected subsystem before changing how something here works; it records why the code is built that way.

## Scope

`scripts/` contains deploy wrappers, agent quality gates, code-health checks, and repo maintenance utilities.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`; use `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave shell options to their
  caller.
- Parse JSON with Node, jq, or structured tooling. Do not scrape JSON with grep or sed.
- Compact/watch scripts must keep machine state and cadence metadata separate
  from human display strings. Gate emissions on stable fields, not volatile
  counters, block heights, or formatted progress lines.
- Wrappers that deploy local checkout state source
  `scripts/lib/deploy-guard.sh` before mutation. `deploy-indexer:promote` acts
  on a registered remote deployment; use it through the `deploy-indexer` skill
  after its clean-tree preflight, verification, and explicit production
  approval.
- Do not add `--no-verify` to normal Git commands. `deploy-indexer.sh` uses it
  only for `envio` trigger-ref pushes, which intentionally skip redundant
  pre-push hooks; do not generalize that exception.
- New deploy scripts must print the target, commit, and rollback or verification command before/after mutation.
- New Node root scripts must be covered by `pnpm lint:scripts`; new shell scripts
  must pass `bash -n`. Add a focused command to `scripts/agent-quality-gate.sh`
  for behavior that syntax and lint checks cannot verify.
- `pnpm tf:test` owns the deployment source-staging contract. It allows exactly
  five literal checked-in `gcloud builds submit` / `gcloud app deploy`
  callsites, including their source-staging flag and value. Discovery rejects
  additional deploy records recovered from executable shell, package-script,
  workflow, Dockerfile, nested Cloud Build, generated-script, and Terraform
  surfaces. In Node/TypeScript, static recovery covers direct call/new
  expressions with inline literals or supported `const`/object aliases, plus
  static tagged-template commands. Indirect `Function.prototype.call`/`apply`,
  dynamically constructed executables, and dynamic paths remain forbidden but
  are outside this static proof. Native PowerShell block comments and batch
  `REM`/`::` lines are deliberately not parsed or masked, so deploy-shaped text
  there fails closed; inert examples belong only in
  `scripts/deploy-staging-contract.test.mjs`.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping adds `bash -n` for changed
shell scripts, `pnpm lint:scripts` for changed Node root scripts, and focused
tests for mapped utilities. Run `pnpm agent:quality-gate:test` when gate routing
changes. For deploy-wrapper changes, also run
`node scripts/check-deploy-root-anchors.test.mjs`.
