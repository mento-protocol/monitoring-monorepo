---
title: Denormalize the v2 Broker swap path to de-duplicate router-routed volume
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0017 — Denormalize the v2 Broker swap path to de-duplicate router-routed volume

**Status:** Accepted (May 2026), in force.
**Scope:** indexer-envio

## Context

The homepage shows a v2/v3 volume split. But a v3 router-driven swap also settles
through the legacy v2 Broker (`Broker → BiPoolManager`), so the same economic
volume appears as both a `VirtualPool.Swap` (v3) and a Broker `Swap` (v2). Counting
both double-counts volume.

## Decision

Denormalize each Broker `Swap` at index time with a boolean
`routedViaV3Router` (`tx.to == Routerv300`). The homepage chart excludes Broker
rows that were router-driven, because those are already counted on the v3 side.
The Broker is indexed on Celo only (there is no Broker on Monad).

## Alternatives considered

- **Aggregate/deduplicate at query time in the dashboard** — rejected: pushes chain
  knowledge into the UI and re-does the join on every read.
- **Don't index the v2 Broker at all** — rejected: the genuine v2-only volume leg is
  real and needed for the split.

## Consequences

- The de-dup rule is a data invariant carried on the entity, not a UI filter —
  changing the router address or split logic is a cross-layer change.
- Related fee-revenue accounting has its own de-dup concerns (Mento-stable fee legs);
  keep them distinct from volume.

## Evidence

- Homepage v3(Router)+v2(Broker) volume split PR #318 (2026-05-04).
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md) §Contract Types (Broker).
