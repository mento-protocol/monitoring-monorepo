---
title: A Hasura to Prometheus bridge exists so v3 DB data can drive Grafana alerts
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
scope: metrics-bridge
date: 2026-04
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0027 — A Hasura→Prometheus bridge exists so v3 DB data can drive Grafana alerts

**Status:** Accepted (Apr 2026), in force. Scope extended by
[ADR 0042](0042-metrics-bridge-external-price-poller.md) (Jul 2026): the
bridge additionally hosts an isolated external market-price peg-polling
lifecycle.
**Scope:** metrics-bridge

## Context

The v3 alert plane (ADR 0004) evaluates thresholds in Grafana over Prometheus. But
the v3 signals — pool health, oracle staleness, CDP TCR/ICR, rebalancer liveness —
live in the indexer's Postgres behind Hasura, not in Prometheus. Grafana can't
threshold data it can't scrape.

## Decision

Run a small **`metrics-bridge`** service that reads Hasura/Envio data (and a few RPC
rebalance probes) and exposes them as **Prometheus gauges** for Grafana alert rules.
Prometheus labels must have **bounded cardinality** — never tx hashes, user
addresses, or pool-specific free text.

## Alternatives considered

- **Alert directly off the database** — rejected: the DB has no threshold-evaluation
  or routing engine; that's exactly the gap the bridge fills.
- **Push metrics from the dashboard/indexer** — rejected: mixes read-path and
  export-path concerns; a dedicated exporter keeps the metric surface deliberate.

## Consequences

- New gauges must justify their labels; one narrow exception (`last_oracle_update_url`
  on oracle timestamp gauges) is documented and must not be generalized.
- GraphQL failures and RPC probe failures are separate error channels — never
  collapsed into one boolean. Runs on Cloud Run (`/health`, not `/healthz`).

## Evidence

- metrics-bridge introduced PR #153 (2026-04-17); label + error-channel rules in [`metrics-bridge/AGENTS.md`](../../metrics-bridge/AGENTS.md).
