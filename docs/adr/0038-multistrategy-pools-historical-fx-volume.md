---
title: Model pool strategies many-to-many and price same-currency swaps from historical FX crosses
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
scope: indexer-envio, ui-dashboard, metrics-bridge
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
date: 2026-07
---

# ADR 0038 — Model pool strategies many-to-many and price same-currency swaps from historical FX crosses

**Status:** Accepted (Jul 2026), in force.
**Scope:** indexer-envio, ui-dashboard, metrics-bridge

## Context

Polygon introduced two assumptions that were not true on the earlier pool
fleet. A pool can authorize multiple liquidity strategies simultaneously: the
EURm/EUROP pool has both Open and Reserve strategies after the Open strategy
was registered in a later transaction. It also trades
two EUR-denominated assets, so the existing “take the USD-pegged leg” volume
calculation has no USD leg and would silently omit every swap from USD rollups.

`Pool.rebalancerAddress` cannot represent multiple active strategies. Pricing a
historical EURm/EUROP swap with the dashboard's current EUR price would also
rewrite history whenever EUR/USD moves and would make indexer rollups disagree
with the event-time state.

## Decision

Persist strategy authorization as `PoolLiquidityStrategy`, keyed by pool and
strategy address, with active state and a manifest-derived kind (`OPEN`, `CDP`,
`RESERVE`, or `UNKNOWN`). FPMM authorization events and the OLS/CDP lifecycle
events all write the registry. `Pool.rebalancerAddress` remains a backwards-
compatible pointer to the most recently observed active strategy and falls back
to another active row when that strategy is disabled; it is not authoritative
for cardinality.

For a swap whose two tokens resolve to the same non-USD currency, derive USD
notional from a fresh same-chain currency/USD pool median at that event's
timestamp. The rate is Fixidity-scaled and applied after normalizing the larger
gross token leg to 18 decimals. If no fresh cross exists, keep the swap event
but write the existing zero/uncomputable sentinel so aggregate rollups skip the
sample rather than recording a fabricated zero or a present-day price.

The dashboard renders every positively classified strategy badge and reads the
many-to-many registry both for the fleet view and pool detail. The metrics
bridge probes every active strategy on a critically breached pool and emits
the pool-level blocked gauge only when every strategy returns a confirmed
blocked result. One actionable strategy, skipped classification, or transport
failure keeps that gauge absent rather than publishing a false conclusion.

During the indexer deploy/resync window, isolated strategy queries may fall
back to legacy OLS/CDP/rebalancer sources without breaking the rest of the
consumer. A successful empty registry response remains authoritative; only a
missing-schema validation error activates the compatibility path.

## Alternatives considered

- **Keep one strategy pointer and choose a precedence order** — rejected: it
  hides a real active control path and makes operator diagnosis incomplete.
- **Infer every strategy by probing contract selectors** — rejected: lifecycle
  events plus the contracts manifest provide stronger provenance with no
  per-event RPC fan-out.
- **Value EUR/EUR swaps at $1 or omit them permanently** — rejected: both are
  materially wrong volume accounting.
- **Convert historical swaps with the dashboard's current oracle map** —
  rejected: historical totals would drift with today's FX rate and separate
  consumers would disagree.

## Consequences

- Adding a new strategy family requires a manifest-name classifier or an
  explicit lifecycle kind, and its authorization events must update the shared
  registry.
- Consumers that need complete strategy cardinality use
  `PoolLiquidityStrategy`; the legacy pointer is compatibility-only.
- Pool-level rebalance blockage is an all-active-strategies verdict. The
  Prometheus reason labels remain bounded and carry one deterministic
  representative reason; per-strategy diagnostic detail stays in logs.
- Same-currency volume depends on a fresh currency/USD cross being indexed on
  that chain. Missing or stale pricing is visible as an uncomputable sample,
  not a false dollar amount.
- Deploying this schema and replaying Polygon history is required before the
  new strategy rows and EURm/EUROP USD rollups appear in production.

## Evidence

- Polygon launch transaction `0x28514ec3c8ccd5618896a50aceb0df43cfd87c7a43e3c1874d5e24a35afd995a`
  authorizes the Reserve path for EURm/EUROP; the later Open registration is
  why the full event history, rather than the launch receipt, is authoritative.
- [`indexer-envio/schema.graphql`](../../indexer-envio/schema.graphql)
- [`indexer-envio/src/liquidityStrategies.ts`](../../indexer-envio/src/liquidityStrategies.ts)
- [`indexer-envio/src/usd.ts`](../../indexer-envio/src/usd.ts)
- [`ui-dashboard/src/components/pool-config-panel.tsx`](../../ui-dashboard/src/components/pool-config-panel.tsx)
- [`metrics-bridge/src/rebalance-probe.ts`](../../metrics-bridge/src/rebalance-probe.ts)
