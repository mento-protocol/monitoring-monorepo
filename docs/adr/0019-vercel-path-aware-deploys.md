---
title: Dashboard deploys on Vercel Git integration with a path-aware skip script
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: ui-dashboard
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0019 — Dashboard deploys on Vercel Git integration with a path-aware skip script

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard is the one service that changes constantly, so it should auto-deploy
on `main`. But it lives in a monorepo (ADR 0001): a `terraform/` or `indexer-envio/`
push must not rebuild and redeploy the dashboard, and a docs-only PR must not burn a
preview build.

## Decision

Deploy the dashboard through **Vercel's native Git integration on `main`**, gated by
a **path-aware ignore-build script** (`ui-dashboard/scripts/vercel-ignore-build.sh`,
wired via `ui-dashboard/vercel.json`). The script decides skip-vs-build by diffing
against the right anchor (previous preview SHA, merge-base, or GitHub compare when
Vercel strips `.git`), watching `ui-dashboard/`, `shared-config/`, and workspace
dependency metadata, plus `.lighthouserc.cjs`. The Lighthouse configuration
forces a preview build because the required browser audit targets that preview.

## Alternatives considered

- **Deploy on every push** — rejected: wastes builds and couples the dashboard to
  unrelated changes.
- **Encode the skip in Terraform** — rejected: keeping it in `vercel.json` lets the
  skip logic be reviewed and tested alongside the dashboard code it protects.

## Consequences

- The skip script has several fallback anchors because Vercel's env is inconsistent
  (first push before `gh pr create` lacks PR id/previous SHA); it fails **open**
  (builds) when it can't prove a deploy is dashboard-clean.
- Env-only production changes use the guarded `pnpm deploy:dashboard` wrapper
  from the repository root. It checks the worktree, authentication, and
  Terraform-written project link before calling Vercel.
- The skip script governs which _eligible_ branches build; it does not gate the
  Sentry-autofix trust boundary. `vercel.json` additionally sets
  `git.deploymentEnabled: { "sentry-autofix/*": false }` (issue #1452) so Vercel
  never _creates_ a deployment for a machine-authored autofix branch (which would
  otherwise run untrusted code with the dashboard's production secrets). That is
  strictly earlier than the skip script — the build never starts.

## Evidence

- Deploy model + skip anchors in [`docs/deployment.md`](../deployment.md) §Dashboard Deployment; `ui-dashboard/scripts/vercel-ignore-build.sh`, `ui-dashboard/vercel.json`.
