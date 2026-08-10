---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
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
  callsites, including their source-staging flag and value. It also pins both
  Metrics Bridge submit paths to the checked-in `cloudbuild.yaml`, rejects CLI
  service-account overrides, and verifies that config's exact builder identity
  and logging mode. It keeps direct Cloud Build source-object reads limited to
  the Alloy and Metrics Bridge builders, excluding default Compute. It also
  requires the direct Metrics Bridge bootstrap to
  reconcile the builder's project roles, repository writer, developer act-as
  bindings, build-log reader, exact dedicated-builder source readers, and
  Peg-policy bucket IAM dependency before submitting and rolling out a build.
  That bootstrap must target the two reader instances, never their whole
  `for_each` collection, so a routine deploy cannot enact a pending sibling
  removal reserved for a reviewed full platform apply.
  For an existing Metrics Bridge service, that bootstrap must fail closed if it
  cannot verify the exact service name and must not target the service. A first
  service create and an interrupted public-binding create must use separate
  no-refresh saved plans accepted by `check-metrics-bridge-bootstrap-plan.mjs`.
  The deploy must then verify Terraform state, the live service, and the live
  public binding before building.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  supported static syntax and explicit proof limits. Keep indirect or dynamic
  deploy forms forbidden and inert examples confined to
  `scripts/deploy-staging-contract.test.mjs`.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping adds `bash -n` for changed
shell scripts, `pnpm lint:scripts` for changed Node root scripts, and focused
tests for mapped utilities. Run `pnpm agent:quality-gate:test` when gate routing
changes. For deploy-wrapper changes, also run
`node scripts/check-deploy-root-anchors.test.mjs`.
