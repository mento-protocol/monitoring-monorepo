---
name: monorepo-import
description: Plan and execute conservative imports of sibling monitoring services or alerting stacks into this monorepo. Use when moving an external repo/service into `monitoring-monorepo`, reorganizing alerting/service roots, or wiring package, CI, Terraform, deploy, docs, and post-merge verification around an imported subsystem.
title: Monorepo Import Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-26
---

# Monorepo Import

Use this for importing or reorganizing a deployable monitoring subsystem inside
this repo. Examples: the Aegis import into top-level `aegis/`, and the external
`mento-protocol/alerts` stack landing under `alerts/{infra,rules}`.

## Principle

Preserve runtime behavior first. Do not bundle a redesign, channel migration,
provider swap, or deprecation into the first import unless the user explicitly
widens scope.

## Phase 1: Map Before Moving

Inspect both the source system and this repo before proposing a layout:

- source deployable units, package manager, lockfile, CI workflows, Terraform
  roots/backends, secrets, scheduled jobs, scripts, docs, and live endpoints
- existing repo roots and ownership boundaries: `aegis/`, `alerts/`,
  `terraform/`, `metrics-bridge/`, `indexer-envio/`, `ui-dashboard/`,
  `shared-config/`
- existing root scripts, package filters, CI path filters, dependency-cruiser
  boundaries, AGENTS files, README/docs/runbooks
- current deploy owners: App Engine, Cloud Functions, Terraform, Vercel, Envio,
  Grafana, QuickNode, Sentry, Slack/Discord

Do not treat a directory name as authority. For example, `terraform/alerts` is
the Grafana v3 rule plane, not a generic bucket for every alert-related system.

## Phase 2: Choose The Smallest Layout

Default placement rules:

- If the repo already has peer top-level packages, prefer a peer top-level root
  for a service package (`aegis/`, not `services/aegis/`).
- For alerting, prefer one discoverable top-level `alerts/` namespace while
  preserving deployable subroots underneath it.
- Keep deploy-unit clarity over visual symmetry. Terraform, CI, and operators
  must be able to tell what applies independently.
- Leave Aegis-owned Grafana/Terraform under `aegis/` unless the task explicitly
  includes moving that ownership boundary.

Good import plan shape:

- target tree
- what is copied unchanged
- what gets repo integration glue
- what deliberately stays out of scope
- verification per deploy unit
- rollback or handoff path

## Phase 3: Wire Integration Surfaces

For each imported subsystem, audit and update the relevant surfaces:

- `pnpm-workspace.yaml`, `package.json` root scripts, package names, lockfiles
- package-local `AGENTS.md` and README/runbooks
- `.github/workflows/**` and required-status-safe path/filter behavior
- `.dependency-cruiser.cjs`, knip config, ESLint, TypeScript, test config
- Terraform script entrypoints and backend prefixes/state expectations
- deploy scripts and post-merge deploy workflows
- docs that point at the old standalone repo or old command names

When adding new commands/scripts/workflows, grep canonical docs for stale
patterns and update them in the same PR.

## Phase 4: Verify In Layers

Run the narrow local checks for the imported subsystem first, then the repo's
agent gate:

- package build/typecheck/test/lint for imported TypeScript packages
- `forge test` for imported Foundry helpers/contracts
- Terraform fmt/init/validate/plan for touched Terraform roots; never apply
  without explicit user approval
- workflow syntax and path/filter review for new CI/deploy workflows
- `pnpm agent:quality-gate --run` before opening or updating the PR

If registry/network access is unavailable, do not pretend lockfile or install
work is verified. Surface the blocked command and rerun with network access when
that command is required.

## Phase 5: Ship And Confirm Runtime

After merge, verify the real deploy path for any imported deployable:

- GitHub Actions workflow result for the new deploy workflow
- live health/metrics endpoint where applicable
- Terraform state/output when Terraform owns the runtime
- alert delivery or webhook behavior when alerting plumbing changed

Use live deployment state as truth during post-merge verification. Local branch
staleness or a transient git ref lock is not a reason to ignore a successful
workflow plus live endpoint check.

## Scope Guards

Stop and ask before:

- changing production alert routing semantics
- migrating Slack/Discord/Sentry channels beyond what the import requires
- applying Terraform
- deleting or archiving the source repo
- changing runtime projects/accounts/backends instead of preserving them

Prefer a follow-up issue/PR for redesigns discovered during the import.
