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

> **Architecture decisions** behind these scripts live in [`docs/adr/`](../docs/adr/README.md) — read the relevant ADR for the affected subsystem before changing how something here works; it records why the code is built that way.

## Scope

`scripts/` contains deploy wrappers, agent quality gates, code-health checks,
and repo maintenance utilities. 196 files sit flat at the top level today.

## Target Layout

[ADR 0064](../docs/adr/0064-scripts-module-directories.md) governs
subdirectories here. Each lands in one PR across phases P1–P13 of the scripts
reorganization ([issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877)).
Until a phase merges, its files are flat.

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

Landed: P1, P2. `lib/` (the shared tier; P7 adds to it) and
`production-infra-identity-contract/` predate the reorganization. `setup.sh`
stays flat: `.config/wt.toml` runs that exact path as the Worktrunk pre-start
hook, and eight docs name it.

## Why Files Stay Flat

Six mechanisms pin `scripts/` paths. A file one of them names moves only when
that mechanism moves with it, in the same PR.

- **Autoreview runtime materialization.** `agent-autoreview.sh` names its
  runtime files in Perl copy lists and `runtime_paths` arrays, then materializes
  each from a git blob. A path it does not name is absent at runtime.
- **Gate source-directory guards.** `agent-quality-gate.sh` gates real-tree
  routing on `$script_source_dir == $repo_root/scripts`, so its own stub-repo
  unit tests stay unaffected.
- **Sentry suite manifest.** `sentry-suite-manifest.json` keys are exact
  repo-relative paths, reconciled against `findSentrySuites()` by exact set
  equality both ways. A moved or renamed suite fails the gate closed.
- **Enumerated workflow paths-filters.** 22 of the 32 files in
  `.github/workflows/` pin a `scripts/` path. `ci.yml` (`autoreviewSuite` and
  `autoreviewRootRuntime`; `rootScripts` is the recursive `scripts/**`),
  `infra.yml`, `supply-chain.yml`, `alerts-rules.yml`,
  `peg-policy-publication.yml`, and `schema-diff.yml` list individual files.
- **Production infrastructure contract pins.**
  `production-infra-identity-contract/workflow-inventory.mjs` pins exact script
  paths for the workflows it audits.
- **External console pins.** The Codex Cloud environment console holds the
  setup and maintenance script paths, and Claude Code on the web resolves
  `bootstrap/claude-code-web-setup.sh` through `.claude/hooks/session-start.sh`.
  No repo grep reaches the console: moving `bootstrap/codex-cloud-setup.sh` or
  `bootstrap/codex-cloud-maintenance.sh` needs an operator edit there.

**Any new pin of a `scripts/` path must be listed in this file.** An unrecorded
pin breaks silently on the next move.

## Sweep Checklist for a Move

Run every item in the PR that moves a file.

1. Root `package.json` — 73 entries reference `scripts/`.
2. `check-agent-quality-gate-package-scripts.sh` — pinned alias map.
3. `.github/workflows/` — 22 of 32 files, including the filters above.
4. `.trunk/trunk.yaml` — pre-push hook runs `scripts/agent-quality-gate.sh`.
5. `.claude/settings.json`, `.codex/hooks.json`, `.claude/hooks/session-start.sh`,
   and the verbatim copies and invocation regexes in `check-agent-context.mjs`.
6. `.claude/skills/` and `.agents/skills/` — both mirrors.
7. `docs/notes/quick-commands.md`.
8. `agent-quality-gate.sh` routing arms — a literal-prefix glob such as
   `scripts/deploy-*.sh` or `scripts/sentry-*.test.mjs` stops matching one
   directory down. Keep the basename prefix; add the paired one-level arm.

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
- `pnpm tf plan/apply platform` owns its saved plan. The wrapper captures plan
  JSON only in memory, checks the Metrics Bridge template mode, applies the
  same private plan, uses one mode-`0600` snapshot of each variable file for
  both phases, and deletes its temporary files. Never accept a caller plan path or print,
  upload, or cache either plan form. The guarded first-service bootstrap plans
  below are a separate deploy-only exception. See
  [ADR 0061](../docs/adr/0061-exact-plan-guard-for-manual-platform-applies.md).
- `pnpm tf:test` owns the deployment source-staging contract. It allows exactly
  five literal checked-in `gcloud builds submit` / `gcloud app deploy`
  callsites, including their source-staging flag and value. It also pins both
  Metrics Bridge submit paths to the checked-in `cloudbuild.yaml`, rejects CLI
  service-account overrides, and verifies that config's exact builder identity
  and logging mode. It keeps direct Cloud Build source-object reads limited to
  the Alloy and Metrics Bridge builders, excluding default Compute. It pins the
  App Engine uploader and default AppSpot Storage Admin grants to only the
  service-owned `staging.<project>.appspot.com` bucket and requires the direct
  Metrics Bridge bootstrap to
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
`node scripts/check-deploy-root-anchors.test.mjs`. After a move, run
`pnpm agent:context-check` and `pnpm docs:index`.
