---
title: Read model is SWR polling plus bounded snapshot composition at current scale
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

# ADR 0020 — Read model: SWR polling + bounded snapshot composition at current scale

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard needs near-real-time data from Hasura. Two questions: how to keep it
fresh, and how to compute the 24h volume tiles/table. Live subscriptions add a
stateful transport; server-side aggregation runs into the no-`_aggregate` rule
(ADR 0014).

## Decision

Use **SWR polling** against Hasura for freshness (simple request/refetch, no
websocket transport). Compose each volume surface from bounded rollup reads:

- hero metrics combine pre-rolled per-chain window snapshots with small
  today/first-day overlap slices in the client;
- pool charts paginate `PoolDailyVolumeSnapshot` rows before reducing them;
- top trader and aggregator tables aggregate bounded daily rollup rows.

Server rendering prefetches the primary hero pair as an initial fallback; SWR
owns subsequent freshness. Client composition at the current scale
(approximately 30–50 pools) is acceptable for the pool-level snapshot path.
That scale assumption is not blanket evidence that every hero or table query is
safe: each query must still obey Hasura row caps and expose truncation or
degraded state where applicable.

## Alternatives considered

- **GraphQL subscriptions / websockets** — rejected: adds a stateful transport and
  reconnection logic for data that polling refreshes fine.
- **Server-side `_aggregate`** — rejected by ADR 0014; unbounded query cost.

## Consequences

- The pool-scale assumption is the load-bearing caveat for pool-level snapshot
  composition. If pool count, polling frequency, row volume, latency, or cost
  changes materially, revisit the split between indexer rollups and client
  reduction.
- Polling discipline (intervals, dedupe) is a review surface for stateful UI changes.

## Evidence

- Polling defaults in
  [`ui-dashboard/src/lib/graphql.ts`](../../ui-dashboard/src/lib/graphql.ts);
  bounded queries in
  [`ui-dashboard/src/lib/queries/volume.ts`](../../ui-dashboard/src/lib/queries/volume.ts);
  hero composition in
  [`ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts`](../../ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts);
  SSR fallback in
  [`ui-dashboard/src/lib/volume-ssr.ts`](../../ui-dashboard/src/lib/volume-ssr.ts).
- Polling and row-cap rules in
  [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md);
  the pool-scale exclusion in
  [`docs/pr-checklists/review-prompt-exclusions.md`](../pr-checklists/review-prompt-exclusions.md).
