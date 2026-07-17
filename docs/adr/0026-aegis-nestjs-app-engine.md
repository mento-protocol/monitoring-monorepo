---
title: Aegis is a NestJS App Engine service polling view calls into Prometheus
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: aegis
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0026 — Aegis is a NestJS App Engine service polling view calls into Prometheus

**Status:** Accepted (May 2026, migrated into this repo), in force.
**Scope:** aegis

## Context

Mento v2 alerting predates this monorepo. It polls a set of on-chain view calls on
a schedule and exposes them as Prometheus metrics for Grafana. It was migrated in as
a working service (`aegis/`) rather than rebuilt.

## Decision

Keep Aegis as a **NestJS service on Google App Engine** that polls configured view
calls and serves `/metrics` for Grafana dashboards and alert rules. Its deploy runs
through the `production-services` environment. RPC posture is a deliberate
primary-then-single-fallback with **no breaker and no backoff** (metrics are already
polled on a schedule; backoff would silently extend stale windows).

## Alternatives considered

- **Rebuild v2 alerting on Cloud Run / Cloud Functions** — rejected: Aegis already
  worked; migrating it preserved behavior and the existing App Engine shape.
- **Fold v2 metrics into metrics-bridge** — rejected: metrics-bridge is v3 Hasura→
  Prometheus; Aegis polls v2 view calls directly. Different sources, different service.

## Consequences

- The Aegis Grafana dashboard is owned in `aegis/terraform/`, but its service-health
  **alert rules** live in `alerts/rules/` (moved there 2026-06; see ADR 0028).
- `*_balanceOf` gauges are whole-token units — never divide by `1e6` in PromQL.
- Prometheus labels stay bounded (fixed `contract`/`functionName`/`chain` set).

## Evidence

- Aegis monorepo migration PR #443 (2026-05-19); RPC posture + label discipline in [`aegis/AGENTS.md`](../../aegis/AGENTS.md).
