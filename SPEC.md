---
title: Mento v3 Monitoring Technical Specification
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
---

# Mento v3 Monitoring — Technical Specification

Last updated: 2026-07-17

---

## 1. System Overview

The Mento v3 monitoring system provides real-time visibility into Mento's on-chain FX protocol across Celo, Monad, Polygon, and Ethereum (reserve-yield). It indexes on-chain events from FPMM pools, oracle contracts, factory contracts, Liquity v2 CDP contracts, stable-token supply/custody, bridges (Wormhole NTT), and reserve-yield positions, then exposes them through a GraphQL API and a public dashboard.

### Goals

1. **Operational awareness** — pool health, oracle liveness, trading limit pressure, rebalancer liveness, CDP/stability-pool health
2. **Trade analytics** — volume, TVL, fee revenue per pool over time
3. **Alerting** — proactive alerts when KPIs breach thresholds (Aegis v2, v3 metric alerts, and CDP alerts all live via Grafana → Slack; on-chain multisig and governance events additionally flow through event-driven QuickNode → Cloud Function delivery)
4. **Data access** — Streamlit sandbox for quantitative team (backlog)

### Live Endpoints

| What            | URL                                                 |
| --------------- | --------------------------------------------------- |
| Dashboard       | <https://monitoring.mento.org>                      |
| Mainnet GraphQL | `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql` |

---

## 2. Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Celo (42220) + Monad (143) + Polygon (137) + Ethereum (1, reserve-yield)   │
│ FPMMs · SortedOracles · BreakerBox · Broker · Reserve · Liquity v2 · NTT  │
└──────┬───────────────────────────────────────────┬────────────────────────┘
       │                                           │
 Events (HyperSync)                         View calls (RPC, 10-60s)
       │                                           │
       ▼                                           ▼
┌─────────────────────┐                ┌─────────────────────┐
│  Envio HyperIndex   │                │  Aegis (NestJS)     │
│  (hosted)           │                │  (GCP App Engine)   │
└─────┬─────────┬─────┘                └──────────┬──────────┘
      │         │                                 │
 GraphQL API    │ GraphQL API               /metrics (Prometheus)
      │         │                                 │
      ▼         ▼                                 ▼
┌───────────┐ ┌────────────────┐        ┌──────────────────────┐
│ Next.js   │ │ metrics-bridge │        │  Grafana Alloy       │
│ Dashboard │ │ (Cloud Run,    │        │  (GCP App Engine,    │
│ (Vercel)  │ │  mento-        │        │   aegis/grafana-     │
│ monitoring│ │  monitoring    │        │   agent/)            │
│ .mento.org│ │  GCP project)  │        └──────────┬───────────┘
└───────────┘ └────────┬───────┘                   │
                       │                remote_write (two scrape jobs)
              /metrics (Prometheus gauges)         │
                       │                           │
                       └────────┬──────────────────┘
                                ▼
                  ┌─────────────────────────┐
                  │  Grafana Cloud          │
                  │  clabsmento.grafana.net │
                  │  Dashboards + Alerts    │
                  │  Alert Rules (TF)       │
                  └──────────┬──────────────┘
                             │
                       Notifications
                             │
                ┌────────────┴──────────────────────┐
                │ Splunk On-Call (page severity)    │
                │ Slack #alerts-critical            │
                │ Slack #alerts-oracles / -pools /  │
                │  -cdps / -infra / -reserve /      │
                │  -testnet                         │
                └───────────────────────────────────┘
```

**Metric data paths share a common Grafana Cloud + Grafana Alloy stack; event-driven alerts bypass it:**

1. **Dashboard path**: Envio indexes on-chain events → Hasura GraphQL → Next.js dashboard
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → `/metrics` → Grafana Alloy scrapes + remote-writes → alert rules → Slack `#alerts-critical` + per-domain warning channels + Splunk On-Call (page severity)
3. **v3 alerting (metrics-bridge)**: Envio indexes pool/CDP KPIs → bridge polls Hasura every 30s (default) → `mento_pool_*` / `mento_cdp_*` gauges → Grafana Alloy scrapes → Slack `#alerts-critical` (page-worthy) + per-domain warning channels (`#alerts-oracles` / `#alerts-pools` / `#alerts-cdps` / `#alerts-infra`) — rules in `alerts/rules/`
4. **Event-driven alerting**: QuickNode webhooks → Cloud Functions → Slack (on-chain multisig events, `alerts/infra/onchain-event-handler/`) and Discord/Telegram (governance events, `governance-watchdog/`, own GCP project); Sentry → Slack bridge and the Splunk On-Call rotation announcer also live in `alerts/infra/`

### Components

| Component               | Technology             | Hosting                          | Repo Path                                                              |
| ----------------------- | ---------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Indexer                 | Envio HyperIndex       | Envio hosted                     | `indexer-envio/`                                                       |
| GraphQL API             | Hasura (auto-managed)  | Envio hosted                     | —                                                                      |
| Dashboard               | Next.js 16 + Plotly    | Vercel                           | `ui-dashboard/`                                                        |
| Shared config           | TypeScript             | —                                | `shared-config/`                                                       |
| Metrics bridge (v3)     | Node 24 + prom-client  | Cloud Run (mento-monitoring)     | `metrics-bridge/`                                                      |
| Aegis (v2)              | NestJS                 | App Engine (mento-monitoring)    | `aegis/`                                                               |
| Grafana Alloy collector | Docker (grafana/alloy) | App Engine (mento-monitoring)    | `aegis/grafana-agent/`                                                 |
| Aegis dashboards/folder | Terraform (HCL)        | Grafana Cloud                    | `aegis/terraform/`                                                     |
| Alert rules + routing   | Terraform (HCL)        | Grafana Cloud                    | `alerts/rules/` (incl. Aegis service health, `rules-aegis-service.tf`) |
| Event alert delivery    | TypeScript + Terraform | Cloud Functions (2 GCP projects) | `alerts/infra/`, `governance-watchdog/`                                |
| Aggregator probes       | TypeScript             | GitHub Actions (scheduled)       | `integration-probes/`                                                  |

---

## 3. Networks

All mainnet chains are served by the single Envio project `mento` via
`indexer-envio/config.multichain.mainnet.yaml`. Default start blocks below are
the env-var defaults in that config.

| Network       | Chain ID | Status                                                     | Default Start Block |
| ------------- | -------- | ---------------------------------------------------------- | ------------------- |
| Celo Mainnet  | 42220    | ✅ Live in the production multichain indexer               | 60664500            |
| Monad Mainnet | 143      | ✅ Live in the production multichain indexer               | 60710000            |
| Polygon       | 137      | Configured — live after deploy, sync verification, promote | 90273661            |
| Ethereum      | 1        | ✅ Live — reserve-yield events only (no onBlock heartbeat) | 19111760            |
| Celo Sepolia  | 11142220 | Testnet — hosted dashboard support opt-in via env vars     | —                   |
| Monad Testnet | 10143    | Testnet — hosted dashboard support opt-in via env vars     | —                   |
| Polygon Amoy  | 80002    | Testnet — hosted dashboard support opt-in via env vars     | —                   |

---

## 4. Contracts

Contract addresses are sourced from the published
[`@mento-protocol/contracts`](https://www.npmjs.com/package/@mento-protocol/contracts)
npm package; the active treb deployment namespace per chain is declared in
`shared-config/deployment-namespaces.json`. Every literal address in the Envio
config YAML must resolve to that package, `indexer-envio/config/nttAddresses.json`,
or an explicit allowlist — enforced in CI by `indexer-envio/scripts/checkYamlAddresses.mjs`.

FPMM pools are created dynamically by the `FPMMFactory` proxy
(`0xa849b475FE5a4B5C9C3280152c7a1945b907613b` — same proxy address on Celo,
Monad, and Polygon); the live pool set is visible at
[monitoring.mento.org/pools](https://monitoring.mento.org/pools) or via the
`Pool` entity, so this spec intentionally carries no static pool list.

---

## 5. KPIs and Thresholds

### 5.1 Oracle Liveness

**What:** Is the oracle reporting fresh prices? Measures the ratio of current timestamp to oracle expiry.

**Fields:** `oracleOk` (bool), `oracleTimestamp`, `oracleExpiry`, `oracleNumReporters`

**Applies to:** FPMM pools only (VirtualPools → N/A)

| Status   | Condition                                                                |
| -------- | ------------------------------------------------------------------------ |
| OK       | `oracleOk == true`                                                       |
| WARN     | liveness ratio > 1.2                                                     |
| CRITICAL | liveness ratio > 3 (badly stale) OR `oracleOk == false` (can-trade flag) |

FX pools (EURm, GBPm, …) have the ratio-based thresholds muted Fri 21:00 UTC → Sun 23:00 UTC (markets closed); `oracleOk == false` still pages 24/7.

### 5.2 Deviation Ratio (Oracle Price vs Market)

**What:** How far is the oracle price from the market rate? Measures `priceDifference / rebalanceThreshold`.

**Fields:** `priceDifference`, `rebalanceThreshold`, `healthStatus`

**Applies to:** FPMM pools only

| Status   | Condition                                                                                    |
| -------- | -------------------------------------------------------------------------------------------- |
| OK       | `priceDifference / rebalanceThreshold ≤ 1.01` (within 1% tolerance dead zone)                |
| WARN     | `1.01 < ratio ≤ 1.05` — above tolerance but below critical magnitude, regardless of duration |
| WARN     | `ratio > 1.05` within a 60-min grace window — rebalance is expected                          |
| CRITICAL | `ratio > 1.05` sustained for > 60 min — large breach no longer recoverable by rebalance      |

A 1% tolerance dead zone above the threshold absorbs noise from tiny
overages that aren't user-impacting; the 5% magnitude requirement keeps
duration-driven CRITICAL escalation reserved for genuinely large breaches.
The breach anchor (`deviationBreachStartedAt`) fires at the 1.01x crossing
so the 1h grace counts from when the pool first exceeded tolerance.

The `healthStatus` field on Pool encodes the current status: `"OK"` | `"WARN"` | `"CRITICAL"` | `"N/A"`.

### 5.3 Trading Limit Pressure

**What:** How close are net flows to their configured trading limits? Prevents runaway one-directional flows.

**Fields:** `limitPressure0`, `limitPressure1` (string, e.g. `"0.1230"`), `limitStatus`, `netflow0`, `netflow1`, `limit0`, `limit1`

**Entity:** `TradingLimit` (one per pool per token)

**Applies to:** FPMM pools only

| Status   | Condition                      |
| -------- | ------------------------------ |
| OK       | max pressure < 0.8             |
| WARN     | max pressure > 0.8             |
| CRITICAL | max pressure ≥ 1.0 (limit hit) |

`limitPressure` = `|netflow| / limit` — stored as decimal string for precision.

### 5.4 Rebalancer Liveness + Effectiveness

**What:** Two halves — does the rebalancer _fire_ when the pool is deviated (liveness), and when it fires does it actually _fix_ the deviation (effectiveness)?

**Fields:** `rebalancerAddress`, `rebalanceLivenessStatus`, `lastRebalancedAt`, `lastEffectivenessRatio` on Pool; `effectivenessRatio` on RebalanceEvent; `rebalanceCount` cumulative.

**Applies to:** FPMM pools only

| Status | Condition                          |
| ------ | ---------------------------------- |
| ACTIVE | Rebalancer has rebalanced recently |
| N/A    | Pool is a VirtualPool              |

`effectivenessRatio` per RebalanceEvent = `(priceDifferenceBefore - priceDifferenceAfter) / (priceDifferenceBefore - rebalanceThreshold)` — how much of the **gap to the rebalance boundary** was closed. `1.0` = rebalance landed exactly on the boundary (ideal); `> 1.0` = overshoot past the boundary (e.g. all the way to the oracle midpoint — over-correction that wastes reserves); `< 0` = rebalance made deviation worse.

`Pool.lastEffectivenessRatio` mirrors the most recent event's ratio so the bridge can emit it as a single gauge without a subquery. Alert rule: most recent in-breach rebalance closed <50% of the gap to the boundary AND active breach AND ≥1 rebalance in window (catches persistent control-loop failure, ignores one-off MEV hits).

### 5.5 Stability Pool Headroom (CDPs — live)

**What:** Is there enough collateral in the Stability Pool to absorb liquidations?

**Fields:** `LiquityInstance.spDeposits`, `spColl`, `spHeadroom`,
`systemColl`, `systemDebt`, `tcrBps`, `currentRedemptionRateBps`,
`activeTroveCount`, `icrP1Bps`, `icrP5Bps`, `icrP50Bps`,
`icrFracBelowMcrBps`, `liqCountCum`, `liqDebtOffsetCum`,
`redemptionCountCum`, `redemptionDebtCum`, plus hourly/daily
`LiquityInstanceSnapshot` buckets. Note: `tcrBps` / `icrP*Bps` /
`icrFracBelowMcrBps` are `-1` sentinels today — live TCR/ICR computation is a
tracked refinement (see `docs/ROADMAP.md`, "CDP live risk refinements").

**Applies to:** Liquity v2 CDP pools (TroveManager / StabilityPool per collateral)

| Status   | Condition                          |
| -------- | ---------------------------------- |
| OK       | headroom > 0                       |
| CRITICAL | headroom ≤ 0 (undercollateralized) |

---

## 6. Entity Schema

Source of truth: [`indexer-envio/schema.graphql`](./indexer-envio/schema.graphql) — ~90 entity types. Major families:

- **Pool core**: `Pool` (mutable per-pool state, incl. `lastEffectivenessRatio` + `deviationBreachStartedAt`), `PoolLiquidityStrategy` (authoritative active many-to-many strategy registry), `PoolSnapshot` / `PoolDailySnapshot` (hourly/daily aggregates), `OracleSnapshot` (per-event health timeline), `TradingLimit`, `RebalanceEvent`, `DeviationThresholdBreach`, `LiquidityEvent` / `LiquidityPosition`, `SwapEvent`
- **Breakers**: `Breaker`, `BreakerConfig`, `BreakerTripEvent`, `RateFeed` / `RateFeedDependency`
- **Broker & volume rollups**: `BrokerSwapEvent`, `Broker*DailySnapshot`, `Trader*` aggregates, `VolumeWindowSnapshot`
- **CDPs (Liquity v2)**: `LiquityInstance(+Snapshots)`, `Trove`, `StabilityPool*`, `LiquidationEvent`, `RedemptionEvent`, `CdpPool`, `ReserveTrove`
- **Stables supply/custody**: `StableTokenSupply`, `StableSupplyDailySnapshot`, `StableTokenCustody*`
- **Reserve yield**: `Susds*` and `Steth*` movement/position/summary entities
- **Bridge**: `BridgeTransfer` / `BridgeAttestation` / `Bridge*Snapshot`, `Wormhole*` (NTT)
- **OLS**: `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent`

Pool IDs are namespaced as `{chainId}-{poolAddress}` for multichain support.

---

## 7. Dashboard

### Pages

Public pages (route dirs under `ui-dashboard/src/app/`):

| Route                     | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `/`                       | Global overview — pool/health tiles, global pools table, TVL + volume over-time charts |
| `/pools`                  | All pools across chains (SSR'd initial table), reserves/TVL/24h volume, recent swaps   |
| `/pool/[poolId]`          | Per-pool deep-dive (tabs below)                                                        |
| `/cdps`, `/cdps/[symbol]` | CDP market overview + per-collateral detail (Liquity v2 entities)                      |
| `/stables`                | Stable-token supply/custody views                                                      |
| `/volume`                 | Volume analytics (windows, flow insights)                                              |
| `/bridge-flows`           | Bridge transfer flows (Wormhole NTT)                                                   |
| `/sign-in`                | Custom Auth.js sign-in page                                                            |

Workspace-gated pages (Google-auth, `@mentolabs.xyz`): `/revenue` (canonical
revenue dashboard with actuals, forecasts, and stream tables), `/address-book`,
`/entities`, `/integrations` (aggregator probe snapshots).

#### Pool Detail (`/pool/[poolId]`)

Per-pool deep-dive. The pool header displays the current health/limit badges
(the old numeric "Health Score" was retired). Tabs
(`app/pool/[poolId]/_tabs/`): **Swaps**, **Liquidity**, **LPs**, **Reserves**,
**Oracle** (FPMM only), **Rebalances**, **OLS**.

### Key Components

| Component                                                  | File                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GlobalPoolsTable`                                         | `components/global-pools-table.tsx` (+ `components/global-pools-table/`)   |
| `HealthBadge` / `LimitBadge` / `SourceBadge` / `KindBadge` | `components/badges.tsx`                                                    |
| `HealthPanel`                                              | `components/health-panel.tsx`                                              |
| `LimitPanel`                                               | `components/limit-panel.tsx`                                               |
| `OracleChart`                                              | `components/oracle-chart.tsx` (+ viewport/wheel/hover/decimation siblings) |
| `ReserveChart`                                             | `components/reserve-chart.tsx`                                             |
| `SnapshotChart`                                            | `components/snapshot-chart.tsx`                                            |
| `TvlOverTimeChart`                                         | `components/tvl-over-time-chart.tsx`                                       |
| `TotalRevenueChart`                                        | `components/fee-over-time-chart.tsx`                                       |
| `ChainIcon`                                                | `components/chain-icon.tsx`                                                |
| `Skeletons`                                                | `components/skeletons.tsx`                                                 |

### Pool Type Detection

`isFpmm(pool)` in `ui-dashboard/src/lib/tokens.ts` is the single source of truth for FPMM vs VirtualPool detection. Used to conditionally render oracle health, trading limit, and rebalancer components (shows "N/A" badges for VirtualPools).

### Authentication

Auth.js (NextAuth) with Google provider. Domain-restricted to `@mentolabs.xyz` via Google's server-verified `hd` claim (not the self-reported email) plus an `email_verified === true` check in the sign-in callback. JWT session strategy with 30-day max age and graceful `AUTH_SECRET` / `AUTH_SECRET_PREV` rotation. Custom sign-in page at `/sign-in`. `middleware.ts` gates `/api/address-labels/*` (except backup/restore, which support cron-bearer-token auth), `/api/reserve-yield/*`, and the `/address-book`, `/entities`, `/integrations`, `/revenue` page prefixes. Defense-in-depth is partial: the address-labels handlers independently re-check the session, and the `/entities` and `/integrations` pages verify it server-side, while `/api/reserve-yield/*` and the `/address-book` and `/revenue` pages rely on the middleware matcher alone.

Full CSP and HSTS (with preload) headers shipped; unauthenticated GET endpoints on address labels have been retired. The `/api/hasura/[networkId]` admin-secret proxy is disabled in production.

---

## 8. Network Support

The dashboard is fully multichain — all chains are shown together (no network switcher). Pool IDs are prefixed with `{chainId}-` to disambiguate across chains. A `ChainIcon` component shows the chain logo next to pool identifiers.

| Network       | Chain ID | Indexer Status                 | Dashboard                      |
| ------------- | -------- | ------------------------------ | ------------------------------ |
| Celo Mainnet  | 42220    | Live                           | Live                           |
| Monad Mainnet | 143      | Live                           | Live                           |
| Polygon       | 137      | Configured; live after cutover | Configured; data after cutover |
| Ethereum      | 1        | Live (reserve-yield events)    | Live (reserve-yield views)     |
| Celo Sepolia  | 11142220 | Testnet                        | Opt-in via testnet env vars    |
| Monad Testnet | 10143    | Testnet                        | Opt-in via testnet env vars    |
| Polygon Amoy  | 80002    | Testnet                        | Opt-in via testnet env vars    |

---

## 9. Known Limitations

| Limitation                            | Details                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hasura 1000-row cap                   | Envio hosted Hasura silently caps all queries at 1000 rows; use the pagination helpers or indexer-side rollups                                                                         |
| Cannot run two indexers locally       | Shared Hasura port 8080; use separate Docker projects                                                                                                                                  |
| SortedOracles on Sepolia              | Contracts return zero address; oracle indexing mainnet-only                                                                                                                            |
| Gap-fill not yet implemented          | PoolSnapshot charts may show gaps for periods with no activity                                                                                                                         |
| CDP TCR/ICR gauges are sentinels      | `tcrBps` / `icrP*Bps` / `icrFracBelowMcrBps` are `-1` until live TCR/ICR computation lands ("CDP live risk refinements" in ROADMAP)                                                    |
| Strategy-schema rollout compatibility | Dashboard and metrics consumers fall back to legacy strategy sources only when hosted Hasura does not yet expose `PoolLiquidityStrategy`; a successful empty registry is authoritative |
| Ethereum reserve-yield is event-only  | The historical sUSDS onBlock heartbeat is not registered in the hosted indexer                                                                                                         |

The production GraphQL endpoint is **static** (`2f3dd15` hash survives
redeploys to the same Envio project); the old "endpoint hash changes on each
deploy" limitation is retired — see `indexer-envio/STATUS.md`.

---

## 10. Alerting

### Aegis v2 (live)

Aegis polls v2 contract state via RPC every 10-60s and exposes Prometheus metrics that Grafana Cloud ingests. Protocol alert rules, contact points, global notification policy, message templates, and mute timings are Terraform-managed in `alerts/rules` — including the Aegis service-health rule group (`rules-aegis-service.tf`, relocated from the aegis stack in issue #706). `aegis/terraform` owns only the Aegis dashboard/folder.

Slack is the active delivery path; page-severity alerts still escalate through Splunk On-Call.

| Group            | Rules                                       | Notification Channels                                                               |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Oracle Relayers  | Stale price feeds, low native-token balance | Slack #alerts-oracles + #alerts-critical/Splunk (page, prod chains)                 |
| Reserve Balances | Low balances; exact-zero Polygon USDC/EUROP | Slack #alerts-reserve; #alerts-critical/Splunk (page for exact-zero Polygon)        |
| Trading Modes    | Circuit breakers tripped                    | Slack #alerts-critical/Splunk (page, prod chains); #alerts-testnet (staging chains) |
| Trading Limits   | L0/L1/LG utilization >90%                   | Slack #alerts-pools (L0); #alerts-critical/Splunk (L1/LG, page)                     |
| Aegis Service    | RPC failures, data staleness                | Slack #alerts-infra; #alerts-critical/Splunk (page)                                 |

### v3 Metric Alerts (live)

**Pipeline.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls the Envio indexer every 30s (default `POLL_INTERVAL_MS`) and exports `mento_pool_*` and `mento_cdp_*` Prometheus gauges. Grafana Alloy (`aegis/grafana-agent/`, App Engine in `mento-monitoring`) scrapes and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). The configured FPMM fleet spans Celo, Monad, and Polygon mainnet and reports with <30s staleness once each indexed chain is promoted at the static endpoint.

**Terraform module** `alerts/rules/` — Grafana provider, Slack contact points, global notification policy, message templates, mute timings, and protocol rule groups. Separate state backend (`gs://mento-terraform-tfstate-6ed6/alerts-rules`).

**Slack channels.** Domain-split warnings + cross-service critical channel:

| Channel            | Use                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `#alerts-critical` | Page-worthy — deviation-critical, oracle-down, limit-tripped, rebalancer-stale, bridge-not-reporting |
| `#alerts-oracles`  | Oracle warnings — liveness, report outliers, oracle jump above swap fee                              |
| `#alerts-pools`    | Pool-mechanics warnings — deviation, rebalancer effectiveness, trading-limit pressure                |
| `#alerts-cdps`     | CDP warnings — SP headroom/thinning, liquidation/redemption activity                                 |
| `#alerts-infra`    | Service-infra warnings — indexer, metrics-bridge, Aegis service health                               |

Protocol/Aegis routing additionally uses `#alerts-reserve` (reserve balance) and `#alerts-testnet` (any non-prod chain). Initial rollout was severity-split (`#alerts-warnings` catch-all); refined to per-domain channels once operators wanted to mute/focus by service.

**Rule groups shipped** — the per-rule expression inventory that used to live
here grew past the point where a hand-copied table stays true; the rule files
themselves are the reference. One file per service domain in
`alerts/rules/rules-*.tf`:

| File                                   | `service` label   | Covers                                                                                                                                                                 |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules-fpmms.tf`                       | `fpmms`           | Oracle liveness/down, deviation breach warning/critical (+anchored fallbacks), trading-limit pressure/tripped, rebalancer stale/effectiveness, oracle jump vs swap fee |
| `rules-fpmms-deviation-transitions.tf` | `fpmms`           | Deviation breach state-transition notifications                                                                                                                        |
| `rules-vp-oracles.tf`                  | `fpmms`           | VirtualPool oracle freshness                                                                                                                                           |
| `rules-trading-limits.tf`              | `trading-limits`  | Broker L0/L1/LG trading-limit utilization (Aegis-sourced)                                                                                                              |
| `rules-oracles.tf`                     | `oracles`         | Oracle report outliers                                                                                                                                                 |
| `rules-oracle-relayers.tf`             | `oracle-relayers` | Stale price feeds, low relayer native-token balance                                                                                                                    |
| `rules-cdps.tf`                        | `cdps`            | Stability-pool headroom/thinning, shutdown, liquidation/redemption, shortfall                                                                                          |
| `rules-reserve-balances.tf`            | `reserve`         | Low reserve stable balances plus exact-zero Polygon USDC/EUROP pages (Aegis-sourced `*_balanceOf` gauges)                                                              |
| `rules-trading-modes.tf`               | `exchanges`       | Circuit breakers tripped (trading-mode changes)                                                                                                                        |
| `rules-indexer.tf`                     | `indexer`         | Envio indexer health                                                                                                                                                   |
| `rules-metrics-bridge.tf`              | `metrics-bridge`  | Bridge not-reporting, poll errors, and expected Polygon pool coverage                                                                                                  |
| `rules-aegis-service.tf`               | `aegis`           | Aegis view-call failures plus global and per-production-chain data staleness (page)                                                                                    |
| `rules-aegis-testnet.tf`               | `aegis-testnet`   | Warning-only testnet variants                                                                                                                                          |

See [`docs/notes/polygon-monitoring.md`](./docs/notes/polygon-monitoring.md)
for Polygon's executable coverage map, rollout order, and explicitly tracked
alert gaps.

**Reading alert vs SLO state — paging gate vs uptime accrual**

The "is this critical right now?" gate (health badge, Grafana page) and the
"how much demonstrable downtime" gate (uptime tile) deliberately use
different rules. A single incident can live in different states across
them — surprising the first time you see it.

| Surface                                   | Gate                                                             | What it answers                              |
| ----------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Live health badge (`computeHealthStatus`) | oracle stale OR (`current devRatio > 1.05` AND breach age > 1h)  | Is the pool **right now** in critical state? |
| Live uptime tile (`computePoolUptimePct`) | `healthBinarySeconds / healthTotalSeconds`                       | All-time fraction of seconds in OK state     |
| Grafana critical alert                    | oracle-down rules + (`current ratio > 1.05` AND breach age > 1h) | Should we page on-call **right now**?        |

The uptime tile reads the indexer's binary-health accumulator, which credits
a second to `healthBinarySeconds` only when **all** of these hold for the
interval since the last oracle snapshot: `devRatio ≤ 1.01` (within
tolerance), the oracle is fresh (within `oracleExpiry`), and the interval
isn't FX-weekend closure (which is excluded from both numerator and
denominator). Stale-oracle seconds and any-magnitude breach seconds both
count as unhealthy.

A pool that **peaks at 1.06 then drops to 1.04** (still above the 1.01
tolerance line):

- **Health badge:** WARN (current ratio < 1.05 → not critical, but > 1.01
  → not OK either).
- **Uptime tile:** continues accruing unhealthy seconds at 1.04 (any
  `devRatio > 1.01` is unhealthy in the binary accumulator).
- **Grafana page:** silenced (current ratio dropped below 1.05 — on-call
  sees the immediate problem cleared).

**What this means in practice:**

- The Grafana critical alert silencing **does NOT** mean uptime recovered.
  The binary accumulator keeps ticking until the pool returns to within
  tolerance AND the oracle is fresh.
- If the uptime tile drops without an active critical alert, look for a
  WARN-tier breach (1.01 < ratio ≤ 1.05) or a recent stale-oracle window.
- "Currently critical, paged" → Grafana rule.
  "How much demonstrable downtime, all-time" → `healthBinarySeconds /
healthTotalSeconds` (UI tile) — sourced from the indexer rollup.

The split is deliberate: paging is keyed to "is the immediate problem
ongoing AND severe?" so on-call can clear and silence cleanly, while the
uptime tile is a strict binary SLO that punishes every unhealthy second so
the dashboard doesn't undercount drift. The indexer also maintains
`cumulativeCriticalSeconds` (peak-based, closed breaches only) for SLO
back-testing, but no UI surface reads it today.

**7d subtitle on the Uptime tile:** `PoolDailySnapshot` freezes
`cumulativeHealthBinarySeconds` and `cumulativeHealthTotalSeconds` once per
UTC day. The tile differences today's `Pool.healthBinarySeconds` against
the latest snapshot row at-or-before `now − 7d` to derive a windowed
uptime % over the trailing week. A `↑` / `↓` arrow appears when the 7d
number disagrees with all-time at 2-decimal precision; arrow is suppressed
when both round equal. New pools render `—` for the subtitle until a
≥7d-old snapshot row exists.

**`service` label convention** (matches the existing Aegis pattern of `service = monitored-domain`, not producer):

| `service`                 | Covers                                 |
| ------------------------- | -------------------------------------- |
| `fpmms`                   | FPMM + VP-oracle pool alerts — live    |
| `trading-limits`          | Trading-limit pressure — live          |
| `oracles`                 | Oracle report outliers — live          |
| `oracle-relayers`         | Relayer freshness/balances — live      |
| `cdps`                    | Stability-pool / CDP — live            |
| `reserve`                 | Reserve balances — live                |
| `exchanges`               | Trading-mode / circuit breakers — live |
| `indexer`                 | Envio indexer health — live            |
| `metrics-bridge`          | Bridge self-monitoring — live          |
| `aegis` / `aegis-testnet` | Aegis service health — live            |

**Pipeline topology** (v3 path, distinct from the Aegis v2 path):

```
Envio Hasura ── (poll 30s) ── metrics-bridge ── /metrics ── Grafana Alloy ── remote_write ── Grafana Cloud
 (monitoring-monorepo)          (Cloud Run,            (aegis/grafana-       (clabsmento.
                                 mento-monitoring       agent/, App Engine    grafana.net)
                                 GCP project)           in mento-monitoring)
```

**Operational notes.**

- Bridge image rollouts: `gcloud run services update` via CI (WIF-auth, no long-lived keys). Terraform owns service shape only (`lifecycle.ignore_changes` on image). Rollbacks are self-describing — `--revision-suffix=<sha>-<run-id>`.
- Bridge health probe lives at `/health` (Cloud Run v2 reserves `/healthz`).
- Bridge deploy SA needs `serviceusage.serviceUsageConsumer` + `logging.logWriter`; the `mento-monitoring` bootstrap SA needs project owner.
- Grafana Agent Dockerfile took four sequential fixes (aegis #51-#54) before the first healthy rollout.

## 11. Future Plans

`docs/ROADMAP.md` is the tracked source for status; summary as of this spec's
last-verified date:

### Next

- **Polygon monitoring cutover** — after merge, deploy and sync the multichain indexer, verify the additive schema and Polygon rows, promote the same commit, then roll out the dashboard and approved alert infrastructure/rules.
- **CDP live risk refinements** — compute live TCR/ICR percentiles from accrued interest (today `tcrBps` / `icrP*Bps` are `-1` sentinels) and revisit the stability-pool headroom target.

### Backlog

- `lastOracleUpdateTxHash` on `Pool` — unblocks tx-link enrichment in Slack alerts
- ChainStat / GlobalStat aggregate entities
- Gap-fill logic for snapshot charts
- Streamlit sandbox
- ClickHouse sink for heavy analytics

Previously listed here and since shipped: CDP production rollout + alert rules
(`rules-cdps.tf`), oracle report-outlier alerts (`rules-oracles.tf`), the
global CDP badge cutover to indexed `CdpPool` rows (Celo), the Aegis monorepo
merge, and the Grafana Agent → Alloy migration.

---

## 12. Development

### Running Tests

```bash
pnpm --filter @mento-protocol/ui-dashboard test        # same pattern per package
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/ui-dashboard lint
pnpm agent:quality-gate                                # path-aware routed gate (agents)
```

### CI

GitHub Actions (`.github/workflows/`, 20+ workflows):

- `ci.yml` — aggregate quality check. A `changes` job detects affected packages, then fans out per-workspace quality jobs (shared-config, ui-dashboard incl. Playwright browser tests, indexer-envio incl. codegen + YAML address drift, metrics-bridge, integration-probes, aegis, alerts handler/announcer, governance-watchdog, root scripts). Each runs typecheck + lint (with baseline-growth checks vs main) + knip + tests with coverage (uploaded to Codecov). A final `ci` sentinel aggregates via `re-actors/alls-green` and is the single required CI check on `main`.
- `trunk.yml` — repo-wide format/meta-lint via Trunk; required separately as "Code Quality".
- Terraform stacks: `alerts-rules.yml`, `alerts-infra.yml`, `aegis-terraform.yml`, `governance-watchdog.yml` — plan on PR (read-only SA), apply on merge gated by the `production-infra` GitHub Environment. `infra.yml` only runs `terraform validate` on changed stacks; the platform stack (`terraform/`) is `human-review-required` and applied manually via `pnpm infra:plan` / `pnpm infra:apply`. `terraform-drift.yml` runs scheduled drift detection with sanitized output. `terraform.stacks.json` is the stack registry.
- Deploys: `metrics-bridge.yml` (Cloud Run), `aegis-app-engine.yml`; the indexer deploys by pushing to the `envio` branch; the dashboard auto-deploys via Vercel.
- Advisory: `size-limit.yml`, `lighthouse.yml`, `mutation-testing.yml`, `code-health-duplication.yml`, `schema-diff.yml`, `supply-chain.yml`, `integration-probes.yml` (scheduled probes), `update-snapshots.yml`.
- Envio deploy notifications come from Envio's native Slack integration on the hosted indexer.
- `claude.yml` — `@claude` mention automation; `pr-description.yml` — PR description standard check; `dependabot-auto-merge.yml` — tiered auto-merge for pinned-action bumps.

Branch protection: `CI / ci` + `Code Quality` (Trunk) + Vercel checks required on `main`.
