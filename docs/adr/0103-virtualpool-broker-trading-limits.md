---
title: VirtualPool trading limits come from block-pinned, wrapped-exchange Broker state reads
status: active
owner: eng
canonical: true
last_verified: 2026-10-20
scope: indexer-envio
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0103 — VirtualPool trading limits: a separate entity fed by block-pinned Broker state reads

**Status:** Accepted (Sep 2026), in force.
**Scope:** indexer-envio (read by ui-dashboard and metrics-bridge)

## Context

A VirtualPool is a thin v3 wrapper whose `swap()` calls the Celo v2
`Broker`. The Broker enforces trading limits in `guardTradingLimits`, keyed by
`limitId = exchangeId XOR bytes32(uint160(token))`. The dashboard showed
"Trading Limits N/A" for all 12 VirtualPools because it had no source for that
state.

On 2026-09-14 the AUDm/USDm exchange reached 99.6% (USDm) and 99.9% (AUDm) of
its lifetime global cap. Grafana's "LG Trading Limit Alert [Celo]" fired, fed by
Aegis polling `Broker.tradingLimitsState` every 10s over a hand-maintained list
of 34 limit IDs. The alert plane worked; the dashboard was blind, so an operator
following a page had no pool page to read.

Two contract facts constrain any design:

- `tradingLimitsConfig` / `tradingLimitsState` values are **whole token units**
  (`deltaFlow / 10^decimals`, minimum ±1), unlike the FPMM path's 15-decimal
  internal scale.
- State mutates only through swaps. No event carries it. Only
  `TradingLimitConfigured(bytes32 exchangeId, address token, Config config)`
  is emitted, on configuration.

## Decision

Add a `BrokerTradingLimit` entity, one row per (exchange, token leg), holding
config, state, derived pressures, and status.

- **State** comes from an RPC read pinned to the triggering `Broker.Swap`
  block, through a dedicated effect module
  ([ADR 0016](0016-effect-rpc-split-and-heal-stages.md)). A read that falls back
  to `latest` is discarded and never overwrites a row.
- **Refresh every later swap block for wrapped exchanges**, regardless of the
  stored pressure or age. Suppress reads at or below the row's `stateBlock`:
  an exact-block read already covers all swaps in that block. The former
  300-second, below-80% gate missed a reset followed by a three-second burst
  to the cap on 2026-10-19, leaving the pool at OK with no later swap to heal it.
- **Config is event-sourced** from a newly indexed
  `Broker.TradingLimitConfigured`. The contract's `reset()` runs in that same
  block, so the handler reads state once pinned to the reconfigure block and
  adopts it, rather than pricing a previously sampled netflow against the
  new limit. The read is bounded: governance reconfigures are rare, so it
  carries a `preload-effect-exempt` annotation instead of joining the preload
  pass. When it returns null the handler mirrors `reset()` locally, keeps
  `stateKnown` as it was, and zeroes `stateTimestamp`. A failed read does not
  advance `stateBlock`, so the next later swap block re-reads. The at-block
  config read is a one-time bootstrap for limits
  configured before `start_block`. The `TradingLimitConfigured` fragment is
  appended to the hand-vendored `abis/Broker.json` under the ABI exception rule
  of [ADR 0015](0015-abi-vendoring-and-address-drift-gate.md).
- **Gating is at the exchange level.** Direct v2 swaps and VirtualPool-routed
  swaps move the same limit, so rows key on the exchange, never on the caller.
- **The worst row is denormalized** onto the wrapping pool's existing
  `Pool.limitStatus` and `Pool.limitPressure0/1`. Those slots stay per-token:
  `limitPressure0` is the worst enabled-window pressure for `token0`. Status
  stays `N/A` until a leg has both `configKnown` and `stateKnown`, so a blind
  pool never renders a false OK. The homepage query is unchanged.
- **`mento_pool_limit_pressure` stays FPMM-only.** `metrics-bridge` already
  routes VirtualPools away from the FPMM gauges, and the FPMM-scoped Grafana
  rules in `alerts/rules/rules-fpmms.tf` would page a second time on the same
  breach Aegis already pages for.

Thresholds match the FPMM path: WARN at 0.8, CRITICAL at 1.0, pressure over
`|netflow|`. A window contributes only when its flag bit is set and its limit
is greater than 0.

## Alternatives considered

- **Extend the FPMM `TradingLimit` entity** — rejected: its `decimals: 15`
  contract is load-bearing for `metrics-bridge/src/peg/structural-poller.ts`
  and the dashboard's `formatWei(…, 15)`; whole-unit Broker values would
  silently misrender by 15 orders of magnitude.
- **Derive state locally from swap amounts** — rejected: it contradicts the
  standing rule in `indexer-envio/src/rpc/effects.ts` (Group E), which keeps the
  authoritative per-swap path on an RPC read because local derivation cannot
  prove row contiguity after a transient miss or during a full replay.
- **Read state on every Broker swap, including unwrapped exchanges** —
  rejected: 1–2M archive `eth_call`s per full resync. This is distinct from
  the accepted wrapped-only per-block refresh.
- **Key the read by refresh bucket instead of block** — rejected: a quantized
  block returns state from the bucket boundary, not from the swap's block, so
  the stored netflow would no longer match the event it is attributed to. It
  would make preload dedupe perfectly; correctness of the pinned read wins.
- **Point the dashboard at Grafana or Aegis** — rejected: it makes the pool page
  depend on the alert plane's availability and its hand-maintained limit-ID
  list, and gives the dashboard no historical rows.

## Consequences

- The historical Celo sample had **26,705 wrapped-exchange swaps** out of
  524,004 Broker swaps: at most about **53,400 state reads** (two legs per
  swap), with same-block suppression able to reduce ordered reads. This is a
  historical workload bound, not a new production measurement or a future
  volume cap. The former 300-second gate ranged from a 31,026 perfect-gating
  floor to the same 53,400 ceiling: concurrent preload could already request
  each stale leg's block-pinned read before ordered processing suppressed it.
  Removing the gate increases ordered reads towards that ceiling, not the
  rejected global 1–2M path. At 50 state reads/s the sample ceiling takes about
  18 minutes before bootstrap duplication, retries and config reads. The effect
  stays `cache: false` and rate-limited to 50 dispatches/s. Config is read only while `configKnown`
  is false; ordered bootstrap can change that input after concurrent preload,
  so bootstrap calls can exceed the 24 unique historical leg configs and can
  dispatch state twice for a leg/block (once with config, once without). A
  two-swap cold batch uses six state and four config reads; a known-config
  batch uses four state and zero config reads. The conservative dispatch bound
  is twice the wrapped swap-leg count during cold batches, about 106,800
  state reads for that historical sample, plus retries. This pre-existing
  bootstrap duplication is separate from removing age/pressure suppression.
  Each governance reconfigure also adds one state read. Future replay cost grows
  with wrapped-exchange swap volume; re-measure that volume before rollout.
- State reflects the last successfully read swap block, even when a cool leg
  jumps straight to its cap. A failed read retains the prior row and retries on
  the next swap; an idle exchange cannot repair a failed final read by itself.
  The panel's "as of" time remains useful. Aegis and Grafana keep their 10s
  polling path and remain the paging authority.
- **Rows bootstrap on the first indexed swap for their exchange.** An exchange
  with no swap since the change shipped has no row, and its pool shows the
  "limits refresh on Broker swaps" note, not `N/A` as a claim about the limit.
- The FPMM `TradingLimit` entity, its `decimals: 15` contract, and the peg
  structural poller are unchanged.
- New Broker limit reads belong in the dedicated effect module, not inline in
  `handlers/broker.ts`, per [ADR 0016](0016-effect-rpc-split-and-heal-stages.md).

## Evidence

- PR [#2446](https://github.com/mento-protocol/monitoring-monorepo/pull/2446),
  which implements this decision.
- `indexer-envio/schema.graphql` (`BrokerTradingLimit`, and the `Pool` trading
  limits comment), `indexer-envio/src/brokerTradingLimits.ts`,
  `indexer-envio/src/rpc/broker-trading-limits.ts`,
  `indexer-envio/src/handlers/broker/trading-limits.ts`.
- Group E comment in `indexer-envio/src/rpc/effects.ts`.
- Golden `limitId` vectors for the AUD exchange in `aegis/config.yaml`.
- FPMM-scoped limit rules in `alerts/rules/rules-fpmms.tf`; VirtualPool gauge
  routing in `metrics-bridge/src/metrics.ts` and its
  `mento_pool_limit_pressure` test in `metrics-bridge/test/metrics.test.ts`.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md) §Handler and Data
  Invariants.
