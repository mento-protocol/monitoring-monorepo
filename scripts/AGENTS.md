---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-27
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

Read the relevant [ADR](../docs/adr/README.md) before changing script behavior.

## Scope

`scripts/` holds deploy wrappers, agent quality gates, code-health checks, and
maintenance utilities.

## Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs these
subdirectories.

- `deploy/`: deploy wrappers and Node helpers
- `workflows/`: scripts backing Actions workflow jobs
- `bootstrap/`: container and hosted-session setup
- `context/`: agent context, budget, doc catalog
- `docs/`: audit planner, garden, navigation eval
- `pr/`: PR and issue state projections
- `supply-chain/`: lockfile, audit, pin, skew gates
- `mcp/`: MCP broker, launcher, config rendering
- `alerts/`: alert-rule lint, peg-policy checks
- `repo-health/`: code-health, file-size, lint
- `terraform/`: movable Terraform guards/helpers
- `gate/`: routing engine + coordinator
- `sentry/`: triage/autofix/gate/broker/ci-wiring

`lib/` and `production-infra-identity-contract/` predate the reorg.
`.config/wt.toml` and eight docs pin flat `setup.sh`.
`redrive-onchain-deadletter.{mjs,test.mjs}` stays flat under
`alerts/infra/`; ADR 0064 gives the lint reason.

`lib/` holds cores that multiple clusters read: `hcl.mjs` for Terraform HCL,
`workflow-yaml.mjs` for Actions and shell parsing,
`pnpm-override-selector.mjs` for pnpm overrides, and
`gh-issue-lifecycle.mjs` for shared GitHub issue and label mechanics, which doc
schedulers also read. Local projection keeps only `agent-ready` on create and
all lifecycle labels on closed repair. ADR 0064 lists readers.
`peg-policy-digest.mjs` defines the peg version-digest contract for both
validators. Inventories, pinned hashes, and identities stay with their domain.

## Why Files Stay Flat

`scripts/` has twelve path-pin classes. Move each pin with its file in the
same PR, except the `agent-autoreview.sh` feedback-runtime pins below.

- **Autoreview runtime pins.** The sibling runtime and three-merge feedback-path
  move procedure are in [Script path pins](../docs/notes/agent-quality-gate-mechanics.md#script-path-pins).
- **Gate routing pins.** Exact routing, CI, manifest, and workflow-bridge pins
  are in [Script path pins](../docs/notes/agent-quality-gate-mechanics.md#script-path-pins).
- **Gate runtime pins.** Pre-`cd` helpers, signature roots, and fixture hash
  roots are in [Script path pins](../docs/notes/agent-quality-gate-mechanics.md#script-path-pins).
- **Gate mapping pins.** `gate/routing-table/`, mapping-engine, autoreview-core,
  signature, and Turbo pins are in
  [Script path pins](../docs/notes/agent-quality-gate-mechanics.md#script-path-pins).
- **Evaluation fixture forbidden lists.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names the navigation
  eval's own implementation.
- **Sentry suite manifest.** `scripts/sentry/gate/sentry-suite-manifest.json`
  keys are exact repo-relative paths, reconciled against `findSentrySuites()`
  by set equality both ways. A moved or renamed suite fails the gate closed.
  `sentry/fixture-scan-canary.test.mjs` re-pins four; ADR 0068 has the policy.
- **Enumerated workflow pins.** 23 of 33 files in
  `.github/workflows/` pin a `scripts/` path, and `sentry-triage-agent.yml`
  stages an exact copy list at runtime; three Terraform filters instead
  copy the broad `workflowAdmissionPatterns` boundary from
  `terraform.stacks.json`. A miss is silent: the job stops while `ci` stays
  green. ADR 0064 has the enumeration, the `routing.test.mjs` equality
  contract, and glob rules. Review-eval pins: `docs/evals/review-skill.md`.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` runs the validator from the
  PR's base branch **name**, so it resolves to that branch's tip, never a
  PR-time snapshot. One probe path is enough once the target is live on the base
  branch (issue 1904); a move commit still needs a temporary dual probe.
  ADR 0064 has the failure mode.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud console holds
  `bootstrap/codex-cloud-setup.sh` and
  `bootstrap/codex-cloud-maintenance.sh`; Claude Code web resolves
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  A move needs an operator edit; repo grep cannot reach it.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL and `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. A move changes both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**List each new `scripts/` path pin here.** An unrecorded pin breaks silently on
the next move.

## Sweep Checklist for a Move

Apply every item in
[ADR 0064's move checklist](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
in the same PR.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`, or `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave shell options to their
  caller.
- Parse JSON with Node, jq, or structured tooling, never grep or sed.
- Compact/watch scripts keep machine state and cadence metadata separate from
  display strings. Gate emissions on stable fields, not volatile counters,
  block heights, or progress lines.
- Wrappers that deploy local checkout state source `scripts/lib/deploy-guard.sh`
  before mutation. `deploy-indexer:promote` acts on a registered remote
  deployment; use it through the `deploy-indexer` skill after its clean-tree
  preflight, verification, and production approval.
- Do not add `--no-verify` to normal Git commands. `deploy-indexer.sh` uses it
  only for `envio` trigger-ref pushes, which intentionally skip redundant
  pre-push hooks; never generalize it.
- New deploy scripts print target, commit, and rollback/verification around
  mutation.
- New Node root scripts need `pnpm lint:scripts` coverage; new shell scripts must
  pass `bash -n`. Add a focused command to `scripts/agent-quality-gate.sh` for
  behavior syntax and lint cannot verify.
- No ESLint `max-lines` reaches this tree. The file-size watchlist reports it
  instead — tests aside, three trust-root files exempt:
  [ADR 0065](../docs/adr/0065-scripts-file-size-watchlist-scope.md).
- `pnpm tf plan/apply platform` owns one private saved plan. Never accept a
  caller plan path, or print, upload, or cache either plan form. Mechanism and
  deploy-only bootstrap exception:
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` enforces the deployment source-staging contract. Never add a
  deploy callsite, an indirect or dynamic deploy form, or a CLI service-account
  override; keep inert examples in `scripts/deploy-staging-contract.test.mjs`.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  contract, callsites, and proof limits.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
