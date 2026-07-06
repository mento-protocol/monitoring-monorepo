---
title: Precompute snapshot and rollup entities; never rely on Hasura _aggregate
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-03
---

# ADR 0014 — Precompute snapshot/rollup entities; never rely on Hasura `_aggregate`

**Status:** Accepted (Mar 2026), in force.
**Scope:** indexer-envio (constrains ui-dashboard reads)

## Context

The dashboard needs aggregates: daily volume, TVL over time, per-pool rollups.
Hasura exposes `_aggregate` queries, but running them on hot read paths over
growing event tables is slow, unbounded, and couples UI latency to table size.

## Decision

**Precompute aggregates as first-class snapshot/rollup entities in the indexer**
(e.g. pool snapshots, `BrokerDailySnapshot`, deviation-breach history) and have the
UI read those rows. Hasura `_aggregate` is **not** used on dashboard hot paths;
where the UI must combine rows it paginates and aggregates client-side at current
scale (ADR 0020).

## Alternatives considered

- **`_aggregate` at query time** — rejected: latency grows with history and load;
  the DB does work the indexer can do once at write time.
- **A separate analytics warehouse** — rejected: overkill for the current entity
  volume; snapshot entities keep one system.

## Consequences

- New KPIs usually mean a new snapshot entity + handler, which is a schema-additive
  change and therefore triggers the cross-layer checklist (ADR 0008) and a
  resync-before-merge (ADR 0002).
- Writer correctness matters: snapshot handlers get pure-function tests (ADR 0016).

## Evidence

- Pool snapshot analytics `adab67af` (2026-03-05); Broker daily snapshots for the v2/v3 volume split (ADR 0017).
- No-aggregate rule in [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md).
