---
title: One multichain indexer project; Ethereum reserve-yield shares the hosted deployment
status: active
superseded_by: 0069-susds-launch-aligned-daily-sampler.md (sUSDS event-only clause)
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0012 — One multichain indexer project; Ethereum reserve-yield shares the hosted deployment

**Status:** Accepted (Mar 2026; reserve-yield added Jun 2026; stETH sampler refined by ADR 0034), in force. The sUSDS event-only clause is superseded by [ADR 0069](0069-susds-launch-aligned-daily-sampler.md).
**Scope:** indexer-envio

## Context

Mento runs pools and cross-chain stables on Celo, Monad, and Polygon, with
reserve-yield positions (sUSDS, stETH) on Ethereum. We could run a separate
indexer per chain, but the dashboard shows all chains together and the entity
model is shared. Ethereum is needed only for yield accounting, not full pool
indexing.

## Decision

Run **one Envio project** that indexes Celo, Monad, and Polygon
FPMM/oracle/bridge events, Celo Broker and Liquity/CDP state, and Ethereum
reserve-yield in the same hosted deployment
(`config.multichain.mainnet.yaml`). sUSDS and stETH use bounded,
launch-aligned samplers recorded in [ADR 0069](0069-susds-launch-aligned-daily-sampler.md)
and [ADR 0034](0034-steth-wallet-daily-sampler.md). The historical every-block
sUSDS heartbeat remains excluded from the hosted path. IDs are chain-namespaced
so entities don't collide.

## Alternatives considered

- **One indexer per chain** — rejected: multiplies the deploy/ops surface and forces the
  dashboard to fan out queries across endpoints for a unified view.
- **Full Ethereum indexing** — rejected: only yield accounting is needed there;
  sparse event handlers plus bounded reserve-yield samplers keep sync cheap and
  avoid the historical every-block sUSDS archival heartbeat.

## Consequences

- The production mainnet deployment exposes one Hasura endpoint for Celo,
  Monad, Polygon, and Ethereum reserve-yield. The UI derives the canonical
  network from a namespaced Pool ID and filters entities by `chainId`; testnet
  endpoints remain separately configured.
- Adding a chain means new config + namespaced IDs, not a new deployment.
- Reserve-yield has its own test entry point (`indexer:reserve-yield:test`).

## Evidence

- Multichain analysis `adbe96bb` + namespaced-ID model `48fa96dc` (2026-03);
  reserve-yield slice PR #882 (2026-06).
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md),
  `config.multichain.mainnet.yaml`, and
  [`ui-dashboard/src/lib/pool-id.ts`](../../ui-dashboard/src/lib/pool-id.ts).
