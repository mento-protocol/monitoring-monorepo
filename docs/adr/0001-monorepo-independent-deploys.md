---
title: One pnpm+Turbo monorepo with independently deployed services
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: repo-wide
date: 2026-03
---

# ADR 0001 — One pnpm+Turbo monorepo with independently deployed services

**Status:** Accepted (Mar 2026), in force.
**Scope:** repo-wide

## Context

Mento's v3 monitoring is not one app: it is an indexer, a dashboard, a metrics
exporter, alerting stacks, and several small services that share chain/token
metadata and evolve together but ship to different platforms (Envio, Vercel,
Cloud Run, App Engine, Cloud Functions). We needed shared config and atomic
cross-cutting changes without a release dance across separate repos.

## Decision

Keep everything in one pnpm-workspace + Turbo monorepo. Packages share code
through workspace packages (notably `@mento-protocol/monitoring-config`), but
each service owns its own deploy path and deploys **independently** — a change
to one package does not redeploy the others.

## Alternatives considered

- **Polyrepo (one repo per service)** — rejected: shared chain/token metadata
  would drift across repos, and a schema-to-UI change would span multiple PRs
  with no atomic review.
- **Monorepo with a single coupled deploy** — rejected: the indexer changes
  rarely and the dashboard changes constantly; coupling them wastes builds and
  couples blast radius.

## Consequences

- Cross-package invariants (schema → query → UI) can be changed and reviewed in
  one PR; the repo leans into this with mandatory cross-layer checklists (ADR 0008).
- Each service needs its own skip/ignore logic so unrelated changes don't trigger
  its deploy (see ADR 0019 for the dashboard's path-aware Vercel skip).
- Turbo caches per-package tasks; CI routes checks by changed path.

## Evidence

- `6e001aac` (2026-03-04) initial monorepo setup (Envio indexer + Next.js dashboard).
- `4737c55e` Vercel deployment automation; PR #188 consolidated per-package checks into one CI workflow.
- Package map in [`AGENTS.md`](../../AGENTS.md); topology in [`SPEC.md`](../../SPEC.md).
