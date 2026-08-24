---
title: sUSDS actuals use a launch-aligned bounded daily sampler
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
scope: indexer-envio (constrains ui-dashboard reserve-yield reads)
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0071 — sUSDS actuals use a launch-aligned bounded daily sampler

**Status:** Accepted (Aug 2026), in force.
**Scope:** indexer-envio (constrains ui-dashboard reserve-yield reads)

## Context

The event-only sUSDS path recorded daily rows only when a tracked wallet moved
shares. sUSDS share-price growth continues during quiet periods, so production
could expose a nonzero `SusdsYieldSummary` with no daily rows. The dashboard
then treated a stETH-only history as complete sUSDS reserve actuals.

ADR 0012's sUSDS event-only clause and ADR 0034's matching exception are
superseded by this decision. Their multichain and stETH decisions remain in
force.

## Decision

- Keep Ethereum reserve-yield in the shared multichain Envio deployment.
- Register one sUSDS launch baseline at Ethereum block `24573203`, the final
  block before `2026-03-03T00:00:00Z`. Read the share price at that block and
  write the baseline with the v3 launch timestamp. The launch-day daily yield
  is therefore zero.
- Register one sUSDS sampler every 600 produced Ethereum blocks from
  `max(chain.startBlock, 24573203)`. The sampler reads the block timestamp and
  share price through effects with the same key in preload and processing.
- Skip a sample when the timestamp is unavailable. Fail before any entity write
  when a post-launch share-price read is unavailable. Preload never writes.
- Update one UTC-day row by its deterministic `(chainId, token, day)` ID. Use
  the launch row or latest earlier row as the delta baseline, including across
  days with no intervening sample.
- Do not restore an every-block sUSDS heartbeat.
- The dashboard requires an sUSDS snapshot source when current sUSDS holdings
  or a nonzero earned signal exist. It keeps holdings and forecasts visible,
  but marks reserve actuals unavailable with an explicit sUSDS reason.
- Deployment verification requires the exact immutable sUSDS launch baseline.
  It also fails when a nonzero sUSDS summary has no daily snapshot row.

## Alternatives considered

- **Keep sUSDS event-only** — rejected: quiet-period share-price growth has no
  daily source and can produce false complete actuals.
- **Restore an every-block heartbeat** — rejected: it recreates the hosted
  replay cost and stall class that ADR 0012 removed.
- **Use current reserve API data as historical actuals** — rejected: current
  holdings do not prove the daily earned-yield path or its launch boundary.

## Consequences

- sUSDS and stETH both have launch-aligned bounded actual samplers.
- Daily rows remain sparse and idempotent, with at most one row per UTC day.
- A deployment can be caught up while reserve actuals are still incomplete;
  the verifier and dashboard now fail closed for that state.

## Evidence

- Ethereum block `24573203` has timestamp `1772495999`; block `24573204` has
  timestamp `1772496011`.
- Focused sUSDS sampler tests cover launch baseline, quiet-period growth,
  cross-day deltas, idempotent updates, null effects, and preload no-write
  behavior.
