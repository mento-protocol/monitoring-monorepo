---
title: Precompute snapshot and rollup entities; never rely on Hasura _aggregate
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0014 — Precompute snapshot/rollup entities; never rely on Hasura `_aggregate`

**Status:** Accepted (Mar 2026), in force.
**Scope:** indexer-envio (constrains ui-dashboard reads)

## Context

The dashboard needs aggregates: daily volume, TVL over time, and per-pool
rollups. Hosted Envio Hasura disables `_aggregate`; scanning growing event
tables would also couple UI latency and row-cap risk to history size.

## Decision

**Precompute aggregates as first-class snapshot/rollup entities in the indexer**
(for example `PoolDailySnapshot`, `VolumeWindowSnapshot`, and
`BrokerVolumeWindowSnapshot`) and have the UI read those rows. Never ship
Hasura `_aggregate` queries to the dashboard. Full-lifetime metrics come from a
pre-rolled entity; bounded charts and lists may paginate rollup rows and reduce
them client-side at current scale (ADR 0020).

## Alternatives considered

- **`_aggregate` at query time** — rejected: latency grows with history and load;
  the DB does work the indexer can do once at write time.
- **A separate analytics warehouse** — rejected: overkill for the current entity
  volume; snapshot entities keep one system.

## Consequences

- New full-lifetime KPIs usually mean a new snapshot entity + writer, which is a
  schema-additive change and therefore triggers the cross-layer checklist
  (ADR 0008). A feature branch may be preloaded with `--no-promote`; production
  promotion happens only after merge, protected-main tree verification, and
  explicit authorization (ADR 0002).
- Test writer correctness at the lowest faithful layer. Extract and test
  context-free folds where practical; use context doubles for effectful writers.

## Evidence

- Pool snapshot origin `6e001aac` and analytics `adab67af`; current entities in
  [`indexer-envio/schema.graphql`](../../indexer-envio/schema.graphql) and
  readers in
  [`ui-dashboard/src/lib/queries/volume.ts`](../../ui-dashboard/src/lib/queries/volume.ts).
- No-aggregate rule in [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md).
