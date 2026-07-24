---
title: metrics-bridge hosts the external market-price peg poller
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
scope: metrics-bridge
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0042 — metrics-bridge hosts the external market-price peg poller

**Status:** Accepted (Jul 2026), in force. The isolated poller landed in
PR #1497; protected policy publication and alert activation remain separate
rollout phases in
[`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
**Scope:** metrics-bridge

## Context

Onboarded stablecoins without any oracle-network feed (first case: EUROP on
the Polygon EURm/EUROP FPMM) run on a hardcoded `MANUAL` rate feed pinned to
the peg, protected only by a human-triggered ValueDeltaBreaker. Detecting a
real depeg requires polling external market prices (CEX order books, and for
future assets DEX pools), which no current service can do: Aegis's config
grammar only expresses on-chain view calls, integration-probes writes
route-existence snapshots to Upstash rather than Prometheus, and
[ADR 0027](0027-metrics-bridge-hasura-to-prometheus.md) deliberately scoped
metrics-bridge to Hasura polling plus RPC probes to keep the metric surface
deliberate.

The alert plane for peg deviation must be Grafana-over-Prometheus (the
repo's threshold plane, ADR 0004), so the producer must be a long-running
Prometheus exporter with bounded labels.

## Decision

metrics-bridge gains one additional, isolated polling lifecycle for peg
monitoring, extending — not replacing — ADR 0027's scope:

- A separate peg loop module is started from `main.ts`, following the CDP
  precedent: its gauges live in their own registry module with their own
  reset lifecycle, untouched by `resetPollGauges()`; it has its own bounded
  error-channel values; it never gates `/health` (which remains owned by the
  Hasura pool loop).
- Order-book and aggregator adapters are small pure functions over an
  injected fetch, with per-provider timeout, bounded retry, and request
  budgets written in place. The integration-probes scaffolding is not
  imported: its generic residue is ~30 lines and the rest is welded to
  quote-probe domain types and the Upstash output plane.
- The MVP uses only keyless public market-data endpoints (Kraken, Bitvavo
  ticker/book). Any keyed provider waits for the IaC-modeled Secret Manager
  path required by [ADR 0030](0030-iac-before-cli-secrets.md); no secrets on
  the critical path.
- Structural-flow inputs come from new bounded companion queries against the
  indexer's `SwapEvent` entity (indexed by `poolId, blockTimestamp`, with
  `caller` identity), the already-polled pool reserves, and the indexed
  `TradingLimit` rows (`limit0`/`limit1`, `netflow0`/`netflow1`, window
  update times), which supply the denominator for the saturation fraction —
  swap flow alone gives only the numerator, and pool-level pressure fields
  collapse token direction. Saturation is computed per configured window on
  the monitored token's inflow direction, taking the maximum across the
  active L0/L1 windows. Window durations (`timestep0`/`timestep1`) are
  exposed by neither the indexed `TradingLimit` entity nor the FPMM's
  current RPC surface — `getTradingLimits` returns limits, decimals, and
  netflow state only, and the timestep-bearing `tradingLimitsConfig`
  getter belongs to the legacy Broker. Phase 2 must establish the
  authoritative duration source (indexed configuration events, an FPMM
  getter verified against the deployed ABI, or constants vendored from
  `@mento-protocol/contracts`) and the structural saturation signal fails
  closed as unavailable until that source is verified; a window's retained
  netflow counts only while `now − lastUpdated < timestep`
  (TradingLimitsV2's lazy reset) — stale flow must never feed saturation
  after its window has ended. Swap amounts are normalized from raw token units
  into TradingLimitsV2's fixed 15-decimal limit scale (using each token's
  decimals) before the fraction — `SwapEvent` stores raw event units while
  `TradingLimit.limit*`/`netflow*` use the 15-decimal internal precision,
  so unnormalized division misstates saturation by orders of magnitude.
  Queries page to a bounded maximum and emit an
  explicit saturation flag when the window overflows; per
  [ADR 0014](0014-snapshot-entities-no-aggregate.md), no Hasura
  `_aggregate` — reduction happens in the bridge. Amounts are token-native:
  USD-denominated rollups are defined as zero for pools with no USD-pegged
  leg, so they cannot serve pairs like EURm/EUROP.
- Conversion legs (needed for USD-quoted venues on non-USD pegs) read
  `SortedOracles.medianRate(feedId)` together with
  `SortedOracles.medianTimestamp(feedId)` through the existing per-chain
  viem clients, following the rebalance-probe `readContract` pattern.
  `medianRate` alone returns the last stored value with no age, so the leg
  retains alert authority only while the median timestamp is within the
  feed's effective expiry, resolved live and token-first —
  `tokenReportExpirySeconds(feedId)`, falling back to the zero-argument
  global `reportExpirySeconds()` when the override is unset, mirroring the
  indexer's existing `fetchReportExpiry` helper — never a copied constant,
  so a governance expiry change cannot strand a stale bound — and a stale
  conversion demotes the converted source to
  display before it can create or mask deviation. Conversion is
  currency-directed and explicit: for a venue quoted in currency Q and a
  peg in currency P, the converted price is `venuePx[Q] ÷ f` where `f` is
  the `P/Q` feed's `rate ÷ denominator` (units: Q per P) — e.g. a
  USD-quoted EUROP price divides by the EUR/USD value; legs whose feed
  pair does not compose the venue quote currency into the peg currency are
  rejected at validation. The
  identifiers canonicalized in `oracle-reporters.json` are Mento rate-feed
  IDs, not Chainlink aggregator contracts; a direct aggregator read would
  need a separately canonicalized aggregator address and ABI.

## Alternatives considered

- **Aegis** — rejected: its declarative `MetricSource` grammar expresses
  on-chain view calls only; teaching it HTTP would break its config model.
- **integration-probes** — rejected: scheduled CLI writing to Upstash for
  the dashboard; wrong output plane for Grafana alerting, and its adapter
  scaffolding does not generalize.
- **A new dedicated Cloud Run service** — rejected for now: duplicates
  deploy, liveness, and alert-wiring plumbing, and the structural signal
  wants the bridge's existing Hasura access. Revisit if the peg loop's
  provider count or cadence needs ever threaten the bridge's primary loop.
- **Keeping the bridge single-purpose (status quo of ADR 0027)** — rejected:
  oracle-less assets are expected to recur; leaving them unmonitored keeps
  a standing blind spot against the protocol's own reserve.

## Consequences

- metrics-bridge becomes the repo's single Prometheus producer for both
  on-chain-derived and external-market peg data; ADR 0027's "deliberate
  metric surface" rule now covers the `mento_peg_*` family too.
- The bridge's egress allowlist must include the market-data hosts; a venue
  API change is a bridge deploy, not an alerts-plane change.
- Peg-loop failures are contained at the gauge-lifecycle and error-channel
  level and do not gate the bridge's primary `/health` signal. Both loops
  share one Node process, so this is containment, not process isolation.
  Peg-specific liveness/page rules must land before the new gauges become
  alert-authoritative. The peg loop must catch at top level and bound response
  sizes, timeouts, and per-poll work; a separate service is the escalation if
  shared event-loop interference is ever observed.
- Adding a monitored asset whose venues are already supported is a registry
  change ([ADR 0043](0043-peg-registry-service-local.md)); adding a venue is
  one adapter plus fixtures.

## Evidence

- `docs/PLAN-peg-monitoring.md` (design, venue evidence, phasing)
- `metrics-bridge/src/poller.ts`, `metrics-bridge/src/cdp-metrics.ts`
  (isolated-loop and gauge-lifecycle precedents)
- `metrics-bridge/src/main.ts`, `metrics-bridge/src/peg/runtime.ts`
  (implemented isolated peg lifecycle)
- `indexer-envio/schema.graphql` (`SwapEvent`, pool reserves)
- ADRs 0004, 0014, 0027, 0030
