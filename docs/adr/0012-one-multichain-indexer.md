---
title: One multichain indexer project; Ethereum reserve-yield is event-only
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-03
---

# ADR 0012 — One multichain indexer project; Ethereum reserve-yield is event-only

**Status:** Accepted (Mar 2026; reserve-yield added Jun 2026), in force.
**Scope:** indexer-envio

## Context

Mento runs on Celo and Monad, with reserve-yield positions (sUSDS, stETH) on
Ethereum. We could run a separate indexer per chain, but the dashboard shows all
chains together and the entity model is shared. Ethereum is needed only for
yield accounting, not full pool indexing.

## Decision

Run **one Envio project** that indexes Celo + Monad FPMM/oracle/broker/bridge
events and Ethereum reserve-yield in the same hosted deployment
(`config.multichain.mainnet.yaml`). Ethereum is **event-only** (sUSDS/stETH
handlers); the historical sUSDS `onBlock` heartbeat is intentionally excluded from
the hosted path. IDs are chain-namespaced so entities don't collide.

## Alternatives considered

- **One indexer per chain** — rejected: triples deploy/ops surface and forces the
  dashboard to fan out queries across endpoints for a unified view.
- **Full Ethereum indexing** — rejected: only yield accounting is needed there;
  event-only keeps sync cheap and avoids an archival-block heartbeat.

## Consequences

- A single static Hasura endpoint serves all chains; network is derived from the
  pool URL in the UI.
- Adding a chain means new config + namespaced IDs, not a new deployment.
- Reserve-yield has its own test entry point (`indexer:reserve-yield:test`).

## Evidence

- Multichain analysis `adbe96bb` + namespaced-ID model `48fa96dc` (2026-03); reserve-yield slice PR #882 (2026-06).
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md), `config.multichain.mainnet.yaml`.
