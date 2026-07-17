---
title: Envio HyperIndex Hosted is the indexer; deploy via a dedicated envio branch
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: repo-wide
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0002 — Envio HyperIndex Hosted is the indexer; deploy via a dedicated `envio` branch

**Status:** Accepted (Mar 2026), in force.
**Scope:** repo-wide (indexer topology)

## Context

We need historical + live indexing of FPMM pools, oracles, breakers, the v2
Broker, bridges, and reserve-yield across Celo, Monad, and Ethereum, exposed as a
queryable API — without running our own indexing infrastructure or archival RPC.

## Decision

Use **Envio HyperIndex on Envio's Hosted Service** as the indexer. The production
indexer is driven by a dedicated `envio` deploy branch that Envio watches; code
lands on `main` normally and is pushed to `envio` only when the indexer changes.
Deployments are built, synced, verified, and then **explicitly promoted** to the
static production endpoint, with a defined rollback path.

## Alternatives considered

- **Self-hosted subgraph / custom indexer** — rejected: operational burden of
  archival nodes, reorg handling, and sync ops we don't want to own.
- **Auto-deploy the indexer on every `main` push** — rejected: indexer changes are
  rare; a deploy branch avoids constant reindexes and keeps promotion deliberate.

## Consequences

- A promote step gates production: sync a deployment, verify rows, then promote —
  the endpoint hash is static and doesn't change on redeploy.
- Schema-additive changes must ship as one PR that resyncs and promotes **before**
  merge, or the dashboard breaks (see the schema-single-PR discipline).
- Rollback is re-promote-if-live else rebuild+resync; both are scripted.

## Evidence

- `e6ed54ea` (2026-03-04) Envio hosted migration plan; `1ec14042` deploy-branch strategy.
- Full workflow + rollback in [`docs/deployment.md`](../deployment.md); `deploy:indexer*` scripts.
- Indexer scope in [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md).
