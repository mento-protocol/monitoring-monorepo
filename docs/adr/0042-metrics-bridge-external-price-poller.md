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

**Status:** Accepted (Jul 2026), in force. Decided ahead of implementation;
the poller lands in a follow-up PR per the phasing in
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
  `caller` identity) plus the already-polled pool reserves. Queries page to a
  bounded maximum and emit an explicit saturation flag when the window
  overflows; per [ADR 0014](0014-snapshot-entities-no-aggregate.md), no
  Hasura `_aggregate` — reduction happens in the bridge. Amounts are
  token-native: USD-denominated rollups are defined as zero for pools with
  no USD-pegged leg, so they cannot serve pairs like EURm/EUROP.
- Conversion legs (needed for USD-quoted venues on non-USD pegs) read
  on-chain Chainlink aggregators through the existing per-chain viem
  clients, following the rebalance-probe `readContract` pattern.

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
- Peg-loop failures are isolated: they can never wipe or stall the pool
  gauges, and vice versa; each loop pages through its own liveness rules.
- Adding a monitored asset whose venues are already supported is a registry
  change ([ADR 0043](0043-peg-registry-service-local.md)); adding a venue is
  one adapter plus fixtures.

## Evidence

- `docs/PLAN-peg-monitoring.md` (design, venue evidence, phasing)
- `metrics-bridge/src/poller.ts`, `metrics-bridge/src/cdp-metrics.ts`
  (isolated-loop and gauge-lifecycle precedents)
- `indexer-envio/schema.graphql` (`SwapEvent`, pool reserves)
- ADRs 0004, 0014, 0027, 0030
