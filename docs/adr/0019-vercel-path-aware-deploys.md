---
title: Dashboard deploys on Vercel Git integration with a path-aware skip script
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ui-dashboard
date: 2026-03
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
dependency metadata.

## Alternatives considered

- **Deploy on every push** — rejected: wastes builds and couples the dashboard to
  unrelated changes.
- **Encode the skip in Terraform** — rejected: keeping it in `vercel.json` lets the
  skip logic be reviewed and tested alongside the dashboard code it protects.

## Consequences

- The skip script has several fallback anchors because Vercel's env is inconsistent
  (first push before `gh pr create` lacks PR id/previous SHA); it fails **open**
  (builds) when it can't prove a deploy is dashboard-clean.
- Env-only production changes need a manual `vercel deploy --prod` from the repo root.

## Evidence

- Deploy model + skip anchors in [`docs/deployment.md`](../deployment.md) §Dashboard Deployment; `ui-dashboard/scripts/vercel-ignore-build.sh`, `ui-dashboard/vercel.json`.
