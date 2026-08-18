---
title: Scripts Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-17
doc_type: agent-instructions
scope: scripts
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Scripts

> **Architecture decisions** behind these scripts live in [`docs/adr/`](../docs/adr/README.md) — read the relevant ADR before changing how something here works; it records why the code is built that way.

## Scope

`scripts/` holds deploy wrappers, agent quality gates, code-health checks, and
repo maintenance utilities. 155 files sit flat at the top level today.

## Target Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs
subdirectories here. Each lands in one PR across phases P1–P13
([issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877)).
Files stay flat until their phase merges.

| Directory       | Phase | Holds                                  |
| --------------- | ----- | -------------------------------------- |
| `workflows/`    | P1    | scripts backing Actions workflow jobs  |
| `bootstrap/`    | P2    | container and hosted-session setup     |
| `context/`      | P3    | agent context, budget, doc catalog     |
| `docs/`         | P4    | audit planner, garden, navigation eval |
| `pr/`           | P5    | PR and issue state projections         |
| `supply-chain/` | P6    | lockfile, audit, pin, skew gates       |
| `mcp/`          | P6    | MCP broker, launcher, config rendering |
| `alerts/`       | P8    | alert-rule lint, peg-policy checks     |
| `repo-health/`  | P9    | code-health, file-size, lint wrappers  |
| `terraform/`    | P10   | movable Terraform guards and helpers   |
| `gate/`         | P11   | quality-gate satellites                |

Landed: P1, P2, P3, P4, P6, P7, P10. `lib/` (the shared tier) and
`production-infra-identity-contract/` predate the reorganization. `setup.sh`
stays flat: `.config/wt.toml` runs that exact path as the Worktrunk pre-start
hook, and eight docs name it.

`lib/` holds generic cores carrying no domain policy: `hcl.mjs` (Terraform HCL
tokenizer and block extraction), `workflow-yaml.mjs` (Actions workflow and
shell-run parsing), `pnpm-override-selector.mjs` (pnpm override selectors), and
`gh-issue-lifecycle.mjs` (the `gh` runner, pagination guard, Documentation
Garden workflow authorization, label bootstrap, and issue-queue arbitration).
Cores stay outside domain directories: five files beyond
`production-infra-identity-contract/` read `hcl.mjs`, the ADR 0053
deploy-staging contract reads `workflow-yaml.mjs`, both the lockfile-lint gate
and the override prune advisor read the selector parser, and the documentation
garden and navigation-eval schedulers both read the issue lifecycle. Inventories,
pinned hashes, and identities stay with their domain.

## Why Files Stay Flat

Ten mechanisms pin `scripts/` paths. A file one of them names moves only when
that mechanism moves with it, in the same PR.

- **Autoreview runtime materialization.** `agent-autoreview.sh` names its
  runtime files in Perl copy lists and `runtime_paths` arrays, then materializes
  each from a git blob. A path it omits is absent at runtime.
- **Gate source-directory guards.** `agent-quality-gate.sh` gates real-tree
  routing on `$script_source_dir == $repo_root/scripts`, leaving its stub-repo
  unit tests unaffected.
- **Gate runtime module pins.** `agent-quality-gate.sh` names
  `docs/docs-navigation-eval-helpers.mjs` in two separate literals, and both
  must move together.
- **Evaluation fixture forbidden lists.** `forbidden_sources` in
  `docs/evals/documentation-navigation-fixtures.json` names the navigation
  eval's own implementation by exact path.
- **Sentry suite manifest.** `sentry-suite-manifest.json` keys are exact
  repo-relative paths, reconciled against `findSentrySuites()` by set equality
  both ways. A moved or renamed suite fails the gate closed.
- **Enumerated workflow paths-filters.** 22 of 32 files in
  `.github/workflows/` pin a `scripts/` path. `ci.yml` (`autoreviewSuite`,
  `autoreviewRootRuntime`, `versionSkew`; `rootScripts` is the recursive
  `scripts/**`), `infra.yml`, `alerts-rules.yml`, `peg-policy-publication.yml`,
  and `schema-diff.yml` list individual files. The three terraform filters
  (`ci.yml` `terraform`; `infra.yml` push and `pull_request`) also name
  `scripts/lib/hcl.mjs` and `scripts/lib/workflow-yaml.mjs`, outside the
  recursive `scripts/production-infra-identity-contract/**`; `routing.test.mjs`
  there asserts all three. A miss is silent — the job stops running while the
  required `ci` sentinel stays green. ADR 0064 covers when a module glob such as
  `supply-chain.yml`'s `scripts/supply-chain/**` is the safer pin.
- **Terraform stack registry.** `terraform.stacks.json` pins exact `scripts/`
  paths per stack.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud environment console holds
  `bootstrap/codex-cloud-setup.sh` and `bootstrap/codex-cloud-maintenance.sh`;
  Claude Code on the web resolves `bootstrap/claude-code-web-setup.sh` through
  `.claude/hooks/session-start.sh`. No repo grep reaches the console: moving
  either needs an operator edit there.
- **Reviewed-artifact byte pins.** `.gitattributes` pins
  `scripts/mcp/upstash-mcp-launcher.mjs` to `text eol=lf`, and
  `UPSTASH_MCP_LAUNCHER_SHA256` in `scripts/mcp/render-upstash-mcp-config.mjs`
  hashes it — a move's depth fix alone changes both. Procedure:
  [`docs/notes/upstash-mcp-operator.md`](../docs/notes/upstash-mcp-operator.md).

**Any new pin of a `scripts/` path must be listed here.** An unrecorded pin
breaks silently on the next move.

## Sweep Checklist for a Move

Work the ten-surface checklist in
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
- `pnpm tf plan/apply platform` owns its saved plan. The wrapper keeps plan JSON
  in memory only, checks the Metrics Bridge template mode, applies that same
  private plan, uses one mode-`0600` snapshot of each variable file for both
  phases, and deletes its temporary files. Never accept a caller plan path, or
  print, upload, or cache either plan form. The guarded first-service bootstrap
  plans below are a deploy-only exception. See
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` enforces the deployment source-staging contract: the five
  allowed `gcloud builds submit` / `gcloud app deploy` callsites, the Metrics
  Bridge build config, its guarded no-refresh bootstrap plans, and the staging
  bucket IAM. Never add a callsite, an indirect or dynamic deploy form, or a CLI
  service-account override, and keep inert examples in
  `scripts/deploy-staging-contract.test.mjs`.
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) owns the
  contract, its supported static syntax, and its explicit proof limits.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
