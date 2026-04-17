# Mento v3 Monitoring — Technical Specification

Last updated: 2026-04-16

---

## 1. System Overview

The Mento v3 monitoring system provides real-time visibility into Mento's on-chain FX protocol on Celo. It indexes on-chain events from FPMM pools, oracle contracts, and factory contracts, then exposes them through a GraphQL API and a public dashboard.

### Goals

1. **Operational awareness** — pool health, oracle liveness, trading limit pressure, rebalancer liveness
2. **Trade analytics** — volume, TVL, fee revenue per pool over time
3. **Alerting** — proactive alerts when KPIs breach thresholds (Aegis v2 live; v3 FPMM alerts next)
4. **Data access** — Streamlit sandbox for quantitative team (backlog)

### Live Endpoints

| What            | URL                                                 |
| --------------- | --------------------------------------------------- |
| Dashboard       | <https://monitoring.mento.org>                      |
| Mainnet GraphQL | `https://indexer.hyperindex.xyz/60ff18c/v1/graphql` |

---

## 2. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                     Celo Chain (42220)                       │
│  FPMMs · SortedOracles · BreakerBox · Broker · Reserve      │
└────────────┬────────────────────────────┬───────────────────┘
             │                            │
   Events (HyperSync)            View calls (RPC, every 10-60s)
             │                            │
             ▼                            ▼
  ┌─────────────────────┐     ┌─────────────────────┐
  │  Envio HyperIndex   │     │  Aegis (NestJS)     │
  │  (hosted)           │     │  (GCP App Engine)   │
  └──────────┬──────────┘     └──────────┬──────────┘
             │                           │
        GraphQL API                 /metrics (Prometheus)
             │                           │
             ▼                           ▼
  ┌─────────────────────┐     ┌─────────────────────┐
  │  Hasura / Postgres  │     │  Grafana Agent      │
  │  (managed by Envio) │     │  (GCP App Engine)   │
  └──────────┬──────────┘     └──────────┬──────────┘
             │                           │
             ▼                           ▼
  ┌─────────────────────┐     ┌─────────────────────┐
  │  Next.js Dashboard  │     │  Grafana Cloud      │
  │  (Vercel)           │     │  Dashboards + Alerts│
  │  monitoring.mento.org│    │  Alert Rules (TF)   │
  └─────────────────────┘     └──────────┬──────────┘
                                         │
                                    Notifications
                                         │
                              ┌──────────┴──────────┐
                              │  Discord (8 channels)│
                              │  Splunk On-Call      │
                              └─────────────────────┘
```

**Two parallel data paths:**

1. **Dashboard path** (left): Envio indexes on-chain events → Hasura GraphQL → Next.js dashboard
2. **Alerting path** (right): Aegis polls contract state via RPC → Prometheus metrics → Grafana Agent → Grafana Cloud → alert rules → Discord/Splunk notifications

### Components

| Component      | Technology            | Hosting       | Repo Path                               |
| -------------- | --------------------- | ------------- | --------------------------------------- |
| Indexer        | Envio HyperIndex      | Envio hosted  | `indexer-envio/`                        |
| GraphQL API    | Hasura (auto-managed) | Envio hosted  | —                                       |
| Dashboard      | Next.js 16 + Plotly   | Vercel        | `ui-dashboard/`                         |
| Shared config  | TypeScript            | —             | `shared-config/`                        |
| Aegis (v2)     | NestJS                | GCP App Eng   | `../aegis/`                             |
| Grafana Agent  | Docker                | GCP App Eng   | `../aegis/grafana-agent/`               |
| Alert rules    | Terraform (HCL)       | Grafana Cloud | `../aegis/terraform/grafana-alerts/`    |
| Grafana dashbd | Terraform (HCL)       | Grafana Cloud | `../aegis/terraform/grafana-dashboard/` |

---

## 3. Networks

| Network       | Chain ID | Status                        | Start Block |
| ------------- | -------- | ----------------------------- | ----------- |
| Celo Mainnet  | 42220    | ✅ Live                       | 60664513    |
| Celo Sepolia  | 44787    | ✅ Live                       | —           |
| Monad Mainnet | —        | ⏳ Blocked on contract deploy | —           |

---

## 4. Contracts (Celo Mainnet)

| Contract      | Address                                      |
| ------------- | -------------------------------------------- |
| FPMMFactory   | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b` |
| Router        | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` |
| OracleAdapter | `0xa472fBBF4b890A54381977ac392BdF82EeC4383a` |
| SortedOracles | `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33` |

### FPMM Pools (Mainnet)

| Address                                      | Pair           |
| -------------------------------------------- | -------------- |
| `0x8c0014afe032e4574481d8934504100bf23fcb56` | USDm / GBPm    |
| `0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d` | USDm / axlUSDC |
| `0x462fe04b4fd719cbd04c0310365d421d02aaa19e` | USDm / USDC    |
| `0x0feba760d93423d127de1b6abecdb60e5253228d` | USDT / USDm    |

---

## 5. KPIs and Thresholds

### 5.1 Oracle Liveness

**What:** Is the oracle reporting fresh prices? Measures the ratio of current timestamp to oracle expiry.

**Fields:** `oracleOk` (bool), `oracleTimestamp`, `oracleExpiry`, `oracleNumReporters`

**Applies to:** FPMM pools only (VirtualPools → N/A)

| Status   | Condition                             |
| -------- | ------------------------------------- |
| OK       | `oracleOk == true`                    |
| WARN     | liveness ratio > 0.8                  |
| CRITICAL | liveness ratio ≥ 1.0 (oracle expired) |

### 5.2 Deviation Ratio (Oracle Price vs Market)

**What:** How far is the oracle price from the market rate? Measures `priceDifference / rebalanceThreshold`.

**Fields:** `priceDifference`, `rebalanceThreshold`, `healthStatus`

**Applies to:** FPMM pools only

| Status   | Condition                                    |
| -------- | -------------------------------------------- |
| OK       | `priceDifference / rebalanceThreshold < 0.8` |
| WARN     | ratio ≥ 0.8 sustained for > 15 min           |
| CRITICAL | ratio ≥ 0.8 sustained for > 60 min           |

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

### 5.4 Rebalancer Liveness

**What:** Is the rebalancer bot actively rebalancing pools when needed?

**Fields:** `rebalancerAddress`, `rebalanceLivenessStatus` on Pool; `effectivenessRatio` on RebalanceEvent

**Applies to:** FPMM pools only

| Status | Condition                          |
| ------ | ---------------------------------- |
| ACTIVE | Rebalancer has rebalanced recently |
| N/A    | Pool is a VirtualPool              |

`effectivenessRatio` per RebalanceEvent = `(priceDifferenceBefore - priceDifferenceAfter) / priceDifferenceBefore` — how much of the deviation was corrected.

### 5.5 Stability Pool Headroom (Phase 2)

**What:** Is there enough collateral in the Stability Pool to absorb liquidations?

**Fields:** TBD (requires Liquity v2 indexing — Phase 2)

**Applies to:** Liquity v2 CDP pools (GBPm TroveManager / StabilityPool)

| Status   | Condition                          |
| -------- | ---------------------------------- |
| OK       | headroom > 0                       |
| CRITICAL | headroom ≤ 0 (undercollateralized) |

---

## 6. Entity Schema

Full schema: [`indexer-envio/schema.graphql`](./indexer-envio/schema.graphql)

### Pool

Mutable per-pool state. Updated on every relevant event.

```graphql
type Pool {
  id: ID! # pool address (lowercase)
  token0: String # token0 address
  token1: String # token1 address
  source: String! # "fpmm" | "virtual"
  reserves0: BigInt! # current reserve0
  reserves1: BigInt! # current reserve1
  swapCount: Int! # cumulative swap count
  notionalVolume0: BigInt! # cumulative notional volume in token0
  notionalVolume1: BigInt! # cumulative notional volume in token1
  rebalanceCount: Int! # cumulative rebalance count
  # Oracle state (FPMM only; defaults to zero/false for VirtualPools)
  oracleOk: Boolean!
  oraclePrice: BigInt!
  oraclePriceDenom: BigInt!
  oracleTimestamp: BigInt!
  oracleExpiry: BigInt!
  oracleNumReporters: Int!
  referenceRateFeedID: String!
  priceDifference: BigInt!
  rebalanceThreshold: Int!
  lastRebalancedAt: BigInt!
  healthStatus: String! # "OK" | "WARN" | "CRITICAL" | "N/A"
  # Trading limits (FPMM only)
  limitStatus: String! # "OK" | "WARN" | "CRITICAL" | "N/A"
  limitPressure0: String!
  limitPressure1: String!

  # Rebalancer
  rebalancerAddress: String!
  rebalanceLivenessStatus: String! # "ACTIVE" | "N/A"
  createdAtBlock: BigInt!
  createdAtTimestamp: BigInt!
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
}
```

### PoolSnapshot

Hourly pre-aggregated activity per pool. Industry standard (Uniswap/Balancer pattern).

```graphql
type PoolSnapshot {
  id: ID! # "{poolId}-{hourTimestamp}"
  poolId: String! @index
  timestamp: BigInt! @index # unix timestamp truncated to hour
  # Point-in-time state at end of this hour
  reserves0: BigInt!
  reserves1: BigInt!

  # Per-hour activity
  swapCount: Int!
  swapVolume0: BigInt!
  swapVolume1: BigInt!
  rebalanceCount: Int!
  mintCount: Int!
  burnCount: Int!

  # Running cumulative totals
  cumulativeSwapCount: Int!
  cumulativeVolume0: BigInt!
  cumulativeVolume1: BigInt!

  blockNumber: BigInt!
}
```

Gap-filling (missing hours with no activity) is handled by the dashboard layer via forward-fill — not block handlers (Envio `onBlock` lacks block timestamps).

### OracleSnapshot

Per-oracle-event health snapshot. Powers the dual y-axis oracle chart.

```graphql
type OracleSnapshot {
  id: ID!
  poolId: String! @index
  timestamp: BigInt! @index
  oraclePrice: BigInt!
  oraclePriceDenom: BigInt!
  oracleOk: Boolean!
  numReporters: Int!
  priceDifference: BigInt!
  rebalanceThreshold: Int!
  source: String!
  blockNumber: BigInt!
}
```

### TradingLimit

Per-pool per-token trading limit state.

```graphql
type TradingLimit {
  id: ID! # "{poolId}-{tokenAddress}"
  poolId: String!
  token: String!
  limit0: BigInt!
  limit1: BigInt!
  decimals: Int!
  netflow0: BigInt!
  netflow1: BigInt!
  lastUpdated0: BigInt!
  lastUpdated1: BigInt!
  limitPressure0: String!
  limitPressure1: String!
  limitStatus: String! # "OK" | "WARN" | "CRITICAL"
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
}
```

### RebalanceEvent

Per-rebalance event with effectiveness measurement.

```graphql
type RebalanceEvent {
  id: ID!
  poolId: String! @index
  sender: String!
  priceDifferenceBefore: BigInt!
  priceDifferenceAfter: BigInt!
  improvement: BigInt! # priceDifferenceBefore - priceDifferenceAfter
  effectivenessRatio: String! # improvement / priceDifferenceBefore, e.g. "0.5000"
  txHash: String!
  blockNumber: BigInt!
  blockTimestamp: BigInt! @index
}
```

---

## 7. Dashboard

### Pages

#### Global Overview (`/`)

Protocol-wide metrics dashboard.

**Tiles:**

- Total pools (FPMM + VirtualPool count)
- Active pools (with swap activity)
- Health breakdown (OK / WARN / CRITICAL counts)
- Total swap count
- TVL with 24h/7d/30d change %
- LP count

**Components:**

- `PoolsTable` — all pools with HealthBadge, LimitBadge, RebalancerBadge, TVL Δ WoW, chain icon prefix
- TVL-over-time chart
- Activity ranking by swap count

#### Pool Detail (`/pools/[poolId]`)

Per-pool deep-dive.

**Tabs:**

1. **Overview** — reserve chart (Plotly), recent swaps table
2. **Analytics** — PoolSnapshot charts (hourly volume bars + cumulative count), OracleChart (FPMM only), daily volume chart
3. **Limits** — LimitPanel with trading limit pressure per token
4. **Rebalancer** — RebalancerPanel with liveness status + diagnostics

#### Protocol Revenue (`/revenue`)

Swap fee time-series with 24h/7d/30d/all-time breakdowns. Placeholders for CDP Borrowing Fees and Reserve Yield.

### Key Components

| Component          | File                                 |
| ------------------ | ------------------------------------ |
| `PoolsTable`       | `components/global-pools-table.tsx`  |
| `HealthBadge`      | `components/badges.tsx`              |
| `LimitBadge`       | `components/badges.tsx`              |
| `RebalancerBadge`  | `components/badges.tsx`              |
| `HealthPanel`      | `components/health-panel.tsx`        |
| `LimitPanel`       | `components/limit-panel.tsx`         |
| `RebalancerPanel`  | `components/rebalancer-panel.tsx`    |
| `OracleChart`      | `components/oracle-chart.tsx`        |
| `ReserveChart`     | `components/reserve-chart.tsx`       |
| `SnapshotChart`    | `components/snapshot-chart.tsx`      |
| `TvlOverTimeChart` | `components/tvl-over-time-chart.tsx` |
| `FeeOverTimeChart` | `components/fee-over-time-chart.tsx` |
| `ChainIcon`        | `components/chain-icon.tsx`          |
| `Skeletons`        | `components/skeletons.tsx`           |

### Pool Type Detection

`isFpmm(pool)` in `ui-dashboard/src/lib/tokens.ts` is the single source of truth for FPMM vs VirtualPool detection. Used to conditionally render oracle health, trading limit, and rebalancer components (shows "N/A" badges for VirtualPools).

### Authentication

NextAuth.js with Google provider. Domain-restricted to `@mentolabs.xyz` accounts. JWT session strategy with 30-day max age. Custom sign-in page at `/sign-in`.

---

## 8. Network Support

The dashboard is fully multichain — all chains are shown together (no network switcher). Pool IDs are prefixed with `{chainId}-` to disambiguate across chains. A `ChainIcon` component shows the chain logo next to pool identifiers.

| Network       | Chain ID | Indexer Status                           | Dashboard |
| ------------- | -------- | ---------------------------------------- | --------- |
| Celo Mainnet  | 42220    | Live                                     | Live      |
| Celo Sepolia  | 44787    | Live                                     | Live      |
| Monad Mainnet | 143      | Config ready, blocked on contract deploy | Pending   |

---

## 9. Known Limitations

| Limitation                           | Details                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Endpoint hash changes on each deploy | Envio free tier generates new URL per deploy; requires Vercel env var update                                    |
| Hasura 1000-row cap                  | Envio hosted Hasura silently caps all queries at 1000 rows; use `fetchAllSnapshotPages` or indexer-side rollups |
| Cannot run two indexers locally      | Port 9898 hardcoded in Envio                                                                                    |
| SortedOracles on Sepolia             | Contracts return zero address; oracle indexing mainnet-only                                                     |
| Gap-fill not yet implemented         | PoolSnapshot charts may show gaps for periods with no activity                                                  |
| Monad blocked                        | Awaiting contract deployment to Monad                                                                           |
| No Liquity v2 indexing               | TroveManager / StabilityPool — needed for Stability Pool headroom alerts                                        |
| v3 alerting not yet wired            | Aegis covers v2 KPIs; v3 FPMM-specific alerts are next                                                          |

---

## 10. Alerting

### Current State (Aegis v2)

Aegis is live for Mento v2 alerts. It polls v2 contract state via RPC every 10-60s and exposes Prometheus metrics that Grafana Cloud ingests. All Grafana resources (dashboards, alert rules, contact points, notification policies) are Terraform-managed.

**Live alert groups:**

| Group            | Rules                               | Notification Channels              |
| ---------------- | ----------------------------------- | ---------------------------------- |
| Oracle Relayers  | Stale price feeds, low CELO balance | Discord + Splunk On-Call (mainnet) |
| Reserve Balances | Low USDC/USDT/axlUSDC               | Discord                            |
| Trading Modes    | Circuit breakers tripped            | Discord                            |
| Trading Limits   | L0/L1/LG utilization >90%           | Discord + Splunk On-Call (L1/LG)   |
| Aegis Service    | RPC failures, data staleness        | Discord + Splunk On-Call           |

### Next — v3 FPMM Alerts

Extend alerting to cover v3 FPMM pool KPIs (see §5 for thresholds). Strategy TBD: extend Aegis config, export metrics from Envio indexer, or hybrid.

## 11. Future Plans

### Next

- v3 FPMM alerting (oracle liveness, deviation, trading limits, rebalancer, stability pool)

### Backlog

- Liquity v2 CDP indexing (TroveManager, StabilityPool)
- Monad indexing (blocked on contract deployment)
- Gap-fill logic for snapshot charts
- Streamlit sandbox
- ClickHouse sink for heavy analytics

---

## 12. Development

### Running Tests

```bash
pnpm --filter @mento-protocol/ui-dashboard test
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/ui-dashboard lint
```

### CI

GitHub Actions (`.github/workflows/`):

- `ui-dashboard.yml` — lint + typecheck + test (68 test files) + Codecov
- `indexer-envio.yml` — typecheck + lint
- `notify-envio-deploy.yml` — Discord notification on `deploy/*` push

Branch protection: "Quality Checks" required on `main`.
