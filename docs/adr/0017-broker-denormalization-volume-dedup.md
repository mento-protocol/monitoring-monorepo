---
title: Denormalize the v2 Broker swap path to de-duplicate VirtualPool-routed volume
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0017 — Denormalize the v2 Broker swap path to de-duplicate VirtualPool-routed volume

**Status:** Accepted (May 2026), in force.
**Scope:** indexer-envio

## Context

The homepage shows a v2/v3 volume split. But a v3 router-driven swap also settles
through the legacy v2 Broker (`Broker → BiPoolManager`), so the same economic
volume appears as both a `VirtualPool.Swap` (v3) and a Broker `Swap` (v2). Counting
both double-counts volume.

## Decision

Write every Broker `Swap` to `BrokerSwapEvent` for audit. Mark
`routedViaV3Router` only when `tx.to == Routerv300` **and** the immediate Broker
caller is a registered VirtualPool; a direct legacy Broker call through that
router remains v2. Exclude every VirtualPool caller from the legacy-v2
`BrokerDailySnapshot` and producer rollups, including third-party
aggregator → VirtualPool → Broker paths whose `tx.to` is not `Routerv300`.
`BrokerExchangeDailySnapshot` retains full per-exchange activity. The Broker is
indexed on Celo only; Monad and Polygon have no configured Broker.

## Alternatives considered

- **Aggregate/deduplicate at query time in the dashboard** — rejected: pushes chain
  knowledge into the UI and re-does the join on every read.
- **Don't index the v2 Broker at all** — rejected: the genuine v2-only volume leg is
  real and needed for the split.

## Consequences

- The load-bearing de-duplication happens when legacy-v2 rollups are written;
  the dashboard's `routedViaV3Router: false` predicate is defensive. Changing
  VirtualPool classification or the split logic is a cross-layer change.
- Related fee-revenue accounting has its own de-dup concerns (Mento-stable fee legs);
  keep them distinct from volume.

## Evidence

- Homepage v3(Router)+v2(Broker) volume split PR #318 and the broader
  VirtualPool-caller de-duplication in PR #363.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md) §Contract Types (Broker).
