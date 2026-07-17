---
title: One multichain indexer project; Ethereum reserve-yield shares the hosted deployment
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0012 — One multichain indexer project; Ethereum reserve-yield shares the hosted deployment

**Status:** Accepted (Mar 2026; reserve-yield added Jun 2026; stETH sampler refined by ADR 0034), in force.
**Scope:** indexer-envio

## Context

Mento runs on Celo and Monad, with reserve-yield positions (sUSDS, stETH) on
Ethereum. We could run a separate indexer per chain, but the dashboard shows all
chains together and the entity model is shared. Ethereum is needed only for
yield accounting, not full pool indexing.

## Decision

Run **one Envio project** that indexes Celo + Monad FPMM/oracle/broker/bridge
events and Ethereum reserve-yield in the same hosted deployment
(`config.multichain.mainnet.yaml`). sUSDS remains event-only, stETH uses the
launch-aligned sub-daily wallet sampler recorded in [ADR 0034](0034-steth-wallet-daily-sampler.md),
and the historical sUSDS `onBlock` heartbeat is intentionally excluded from the
hosted path. IDs are chain-namespaced so entities don't collide.

## Alternatives considered

- **One indexer per chain** — rejected: triples deploy/ops surface and forces the
  dashboard to fan out queries across endpoints for a unified view.
- **Full Ethereum indexing** — rejected: only yield accounting is needed there;
  sparse event handlers plus the bounded stETH sub-daily sampler keep sync cheap
  and avoid the historical sUSDS archival-block heartbeat.

## Consequences

- A single static Hasura endpoint serves all chains; network is derived from the
  pool URL in the UI.
- Adding a chain means new config + namespaced IDs, not a new deployment.
- Reserve-yield has its own test entry point (`indexer:reserve-yield:test`).

## Evidence

- Multichain analysis `adbe96bb` + namespaced-ID model `48fa96dc` (2026-03); reserve-yield slice PR #882 (2026-06).
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md), `config.multichain.mainnet.yaml`.
