---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-22
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

> **Architecture decisions** behind these scripts live in [`docs/adr/`](../docs/adr/README.md) — read the relevant ADR before changing how something here works.

## Scope

`scripts/` holds deploy wrappers, quality gates, code-health checks, and repo utilities.

## Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs these
subdirectories.

| Directory       | Holds                                  |
| --------------- | -------------------------------------- |
| `deploy/`       | deploy wrappers and their Node helpers |
| `workflows/`    | scripts backing Actions workflow jobs  |
| `bootstrap/`    | container and hosted-session setup     |
| `context/`      | agent context, budget, doc catalog     |
| `docs/`         | audit planner, garden, navigation eval |
| `pr/`           | PR and issue state projections         |
| `supply-chain/` | lockfile, audit, pin, skew gates       |
| `mcp/`          | MCP broker, launcher, config rendering |
| `alerts/`       | alert-rule lint, peg-policy checks     |
| `repo-health/`  | code-health, file-size, lint wrappers  |
| `terraform/`    | movable Terraform guards and helpers   |
| `gate/`         | quality-gate satellites                |
| `sentry/`       | triage/autofix/gate/broker/ci-wiring   |

`lib/` and `production-infra-identity-contract/` predate the reorganization.
`setup.sh` stays flat because `.config/wt.toml` pins its pre-start path.
`redrive-onchain-deadletter.{mjs,test.mjs}` stays flat although `alerts/infra/`
owns it; ADR 0064 records the lint constraint. `lib/` holds shared cores;
inventories, hashes, and identities stay with their domain.

## Why Files Stay Flat

`scripts/` has eleven path-pin classes. Move each pin with its file in the
same PR, except the `agent-autoreview.sh` feedback-runtime pins below.

- **Autoreview runtime.** `agent-autoreview.sh` pins runtime; feedback helpers
  use `origin/main`. Move paths in three stages: dual path, consumers, cleanup
  (ADR 0064).
- **Gate routing pins.** The gate excludes stub-repo tests when
  `$script_source_dir == $repo_root/scripts`, pairs
  `bootstrap/codex-cloud-setup.{sh,test.sh}` for offline tests, and routes
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` only to its two Sentry
  run-record and finalize tests.
- **Gate runtime module pins.** `agent-quality-gate.sh` sources
  `gate/run-handles.sh` from `$script_source_dir` before it changes directory.
  It also pins `docs/docs-navigation-eval-helpers.mjs` and
  `gate/lockfile-scope.mjs` to that source tree, not stub `$repo_root`. Keep the
  run-handle source, signature, self-test route, and missing-helper fixture in
  step. Repoint every moved path (ADR 0064).
- **Evaluation fixture forbidden lists.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names the navigation
  eval's own implementation.
- **Sentry suite manifest.** `scripts/sentry/gate/sentry-suite-manifest.json`
  keys are exact repo-relative paths, reconciled against `findSentrySuites()`
  by set equality both ways. A moved or renamed suite fails the gate closed.
  `sentry/fixture-scan-canary.test.mjs` re-pins four; ADR 0068 has the policy.
- **Workflow paths-filters.** 22 of 32 `.github/workflows/` files pin a
  `scripts/` path. `ci.yml` has `autoreviewSuite`, `autoreviewRootRuntime`, and
  `versionSkew`; `rootScripts` is recursive `scripts/**`. `infra.yml`,
  `alerts-rules.yml`, `peg-policy-publication.yml`, and `schema-diff.yml` pin
  individual files. The three Terraform filters copy `terraform.stacks.json`
  `workflowAdmissionPatterns`, including `scripts/**`. `routing.test.mjs`
  proves equality and subsumption because a miss can skip a job while the
  required `ci` sentinel remains green. ADR 0064 defines when a module glob is
  safer.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack. The broad workflow admission boundary
  covers the directory; `pnpm tf:test` enforces subsumption.
- **Trusted-validator probes.** `pr-description.yml` resolves the validator
  through the PR base branch name, so it uses the base tip. A move needs a
  temporary dual probe; ADR 0064 records the failure mode.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud console holds two bootstrap paths;
  Claude Code web resolves its bootstrap through `.claude/hooks/session-start.sh`.
  A move needs an operator edit because repo grep cannot reach that console.
- **Reviewed-artifact byte pins.** `.gitattributes` pins the Upstash launcher
  EOL and `UPSTASH_MCP_LAUNCHER_SHA256` hashes it. A move changes both. See
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**Any new pin of a `scripts/` path must be listed here.** An unrecorded pin
breaks silently on the next move.

## Sweep Checklist for a Move

Work the eleven-surface checklist in
[ADR 0064](../docs/adr/0064-scripts-module-directories.md#sweep-checklist-for-a-move)
in the PR that moves a file. Every surface there is mandatory.

## Operating Rules

- Shell entrypoints use `set -euo pipefail`, or `set -Eeuo pipefail` when an
  `ERR` trap needs inheritance. Source-only helpers leave shell options to their
  caller.
- Parse JSON with Node, jq, or structured tooling, never grep or sed.
- Compact/watch scripts must keep machine state and cadence metadata separate
  from display strings. Gate emissions on stable fields, not volatile counters,
  block heights, or progress lines.
- Wrappers that deploy local checkout state source `scripts/lib/deploy-guard.sh`
  before mutation. `deploy-indexer:promote` acts on a registered remote
  deployment; use it through the `deploy-indexer` skill after its clean-tree
  preflight, verification, and production approval.
- Do not add `--no-verify` to normal Git commands. `deploy-indexer.sh` uses it
  only for `envio` trigger-ref pushes, which intentionally skip redundant
  pre-push hooks; never generalize it.
- New deploy scripts must print target, commit, and rollback or verification command around mutation.
- New Node root scripts need `pnpm lint:scripts` coverage; new shell scripts must
  pass `bash -n`. Add a focused command to `scripts/agent-quality-gate.sh` for
  behavior syntax and lint checks cannot verify.
- No ESLint `max-lines` reaches this tree. The file-size watchlist reports it
  instead — tests aside, three trust-root files exempt:
  [ADR 0065](../docs/adr/0065-scripts-file-size-watchlist-scope.md).
- `pnpm tf plan/apply platform` owns one private saved plan. Never accept a
  caller plan path, or print, upload, or cache either plan form. The wrapper
  mechanism and its deploy-only bootstrap exception are in
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` enforces the deployment source-staging contract. Never add a
  deploy callsite, an indirect or dynamic deploy form, or a CLI service-account
  override; keep inert examples in `scripts/deploy-staging-contract.test.mjs`.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  contract, the allowed callsites, and its proof limits.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
