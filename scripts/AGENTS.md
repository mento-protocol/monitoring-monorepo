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
repo maintenance utilities. 188 files sit flat at the top level today.

## Target Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs
subdirectories here. Each lands in one PR across phases P1–P13
([issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877)).
Files stay flat until their phase merges.

| Directory       | Phase | Holds                                  |
| --------------- | ----- | -------------------------------------- |
| `workflows/`    | P1    | scripts backing Actions workflow jobs  |
| `bootstrap/`    | P2    | container and hosted-session setup     |
| `context/`      | P3    | agent context, budget, skill mirrors   |
| `docs/`         | P4    | catalog, audit, garden, nav eval       |
| `pr/`           | P5    | PR and issue state projections         |
| `supply-chain/` | P6    | lockfile, audit, pin, skew gates       |
| `mcp/`          | P6    | MCP broker, launcher, config rendering |
| `alerts/`       | P8    | alert-rule lint, peg-policy checks     |
| `repo-health/`  | P9    | code-health, file-size, lint wrappers  |
| `terraform/`    | P10   | movable Terraform guards and helpers   |
| `gate/`         | P11   | quality-gate satellites                |

Landed: P1, P2, P7, P8. `lib/` (the shared tier) and
`production-infra-identity-contract/` predate the reorganization. `setup.sh`
stays flat: `.config/wt.toml` runs that exact path as the Worktrunk pre-start
hook, and eight docs name it. `redrive-onchain-deadletter.{mjs,test.mjs}` stays
flat although `alerts/infra/` owns it: `eslint.config.mjs` ignores `alerts/**`,
so moving it there drops it out of `lint:scripts`. That ignore is
config-relative; `scripts/alerts/**` stays linted.

`lib/` holds cores more than one cluster reads. `hcl.mjs` (Terraform HCL
tokenizer and block extraction) and `workflow-yaml.mjs` (Actions workflow and
shell-run parsing) carry no domain policy and stay outside domain directories:
five files beyond `production-infra-identity-contract/` read `hcl.mjs`, and the
ADR 0053 deploy-staging contract reads `workflow-yaml.mjs`.
`peg-policy-digest.mjs` is the one definition of the peg version-digest contract
both peg validators check. Inventories, pinned hashes, and identities stay with
their domain.

## Why Files Stay Flat

Seven mechanisms pin `scripts/` paths. A file one of them names moves only when
that mechanism moves with it, in the same PR.

- **Autoreview runtime materialization.** `agent-autoreview.sh` names its
  runtime files in Perl copy lists and `runtime_paths` arrays, then materializes
  each from a git blob. A path it omits is absent at runtime.
- **Gate source-directory guards.** `agent-quality-gate.sh` gates real-tree
  routing on `$script_source_dir == $repo_root/scripts`, leaving its stub-repo
  unit tests unaffected.
- **Sentry suite manifest.** `sentry-suite-manifest.json` keys are exact
  repo-relative paths, reconciled against `findSentrySuites()` by set equality
  both ways. A moved or renamed suite fails the gate closed.
- **Enumerated workflow paths-filters.** 22 of 32 files in
  `.github/workflows/` pin a `scripts/` path. `ci.yml` (`autoreviewSuite` and
  `autoreviewRootRuntime`; `rootScripts` is the recursive `scripts/**`),
  `infra.yml`, `supply-chain.yml`, `alerts-rules.yml`,
  `peg-policy-publication.yml`, and `schema-diff.yml` list individual files.
  The three terraform filters (`ci.yml` `terraform`; `infra.yml` push and
  `pull_request`) also name `scripts/lib/hcl.mjs` and
  `scripts/lib/workflow-yaml.mjs`, outside the recursive
  `scripts/production-infra-identity-contract/**`; `routing.test.mjs` there
  asserts all three. A filter also names what its listed files import.
- **Terraform stack registry.** `terraform.stacks.json` `changedPathPatterns`
  pins exact `scripts/` paths per stack, mirrored into those filters.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud environment console holds
  `bootstrap/codex-cloud-setup.sh` and `bootstrap/codex-cloud-maintenance.sh`;
  Claude Code on the web resolves `bootstrap/claude-code-web-setup.sh` through
  `.claude/hooks/session-start.sh`. No repo grep reaches the console: moving
  either needs an operator edit there.

**Any new pin of a `scripts/` path must be listed here.** An unrecorded pin
breaks silently on the next move.

## Sweep Checklist for a Move

Run every item in the PR that moves a file.

1. Root `package.json` — 73 entries reference `scripts/`.
2. `check-agent-quality-gate-package-scripts.sh` — pinned alias map.
3. `.github/workflows/` — 22 of 32 files, including the filters above.
4. `terraform.stacks.json` — per-stack `changedPathPatterns`.
5. `.trunk/trunk.yaml` — pre-push hook runs `scripts/agent-quality-gate.sh`.
6. `.claude/settings.json`, `.codex/hooks.json`, `.claude/hooks/session-start.sh`,
   and the verbatim copies and invocation regexes in `check-agent-context.mjs`.
7. `.claude/skills/` and `.agents/skills/` — both mirrors.
8. `docs/notes/quick-commands.md`.
9. `agent-quality-gate.sh` routing arms — a literal-prefix glob such as
   `scripts/deploy-*.sh` or `scripts/sentry-*.test.mjs` stops matching one
   directory down. Keep the basename prefix; add the paired one-level arm. Its
   contract-surface arm also names `scripts/lib/*.mjs`, which sets the
   `pnpm tf:test` reason; the unconditional sweep already runs the suite.

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
- `pnpm tf:test` owns the deployment source-staging contract: exactly five
  literal checked-in `gcloud builds submit` / `gcloud app deploy` callsites with
  their source-staging flag and value; both Metrics Bridge submit paths pinned
  to the checked-in `cloudbuild.yaml`, with no CLI service-account override and
  that config's exact builder identity and logging mode; direct Cloud Build
  source-object reads limited to the Alloy and Metrics Bridge builders; App
  Engine uploader and default AppSpot Storage Admin scoped to the service-owned
  `staging.<project>.appspot.com` bucket; and the direct Metrics Bridge
  bootstrap's IAM reconciliation, two-reader targeting, fail-closed service
  check, and guarded plans.
  [`docs/deployment.md`](../docs/deployment.md) owns that sequence and
  [ADR 0053](../docs/adr/0053-explicit-deployment-source-staging.md) the
  supported static syntax and proof limits. Keep indirect or dynamic deploy
  forms forbidden and inert examples confined to
  `scripts/deploy-staging-contract.test.mjs`.

## Verification

Run `pnpm agent:quality-gate --run`; its mapping routes `bash -n`,
`pnpm lint:scripts`, and focused tests for what changed. Add
`pnpm agent:quality-gate:test` for gate routing changes,
`node scripts/check-deploy-root-anchors.test.mjs` for deploy wrappers, and
`pnpm agent:context-check` plus `pnpm docs:index` after a move.
