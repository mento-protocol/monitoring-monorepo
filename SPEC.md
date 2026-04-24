# Mento v3 Monitoring — Technical Specification

Last updated: 2026-04-23

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
| Mainnet GraphQL | `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql` |

---

## 2. Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│            Celo Mainnet (42220)  +  Monad Mainnet (143)                │
│   FPMMs · SortedOracles · BreakerBox · Broker · Reserve                │
└──────┬───────────────────────────────────────────┬────────────────────┘
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
│ Next.js   │ │ metrics-bridge │        │  Grafana Agent       │
│ Dashboard │ │ (Cloud Run,    │        │  (GCP App Engine,    │
│ (Vercel)  │ │  mento-        │        │   aegis repo)        │
│ monitoring│ │  monitoring    │        └──────────┬───────────┘
│ .mento.org│ │  GCP project)  │                   │
└───────────┘ └────────┬───────┘        remote_write (two scrape jobs)
                       │                           │
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
                ┌────────────┴─────────────┐
                │ Discord (Aegis v2)       │
                │ Splunk On-Call           │
                │ Slack #alerts-v3 (v3)    │
                └──────────────────────────┘
```

**Three data paths share a common Grafana Cloud + Grafana Agent stack:**

1. **Dashboard path**: Envio indexes on-chain events → Hasura GraphQL → Next.js dashboard
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Discord + Splunk On-Call
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-v3` (rules pending in `terraform/alerts/`)

### Components

| Component            | Technology             | Hosting                      | Repo Path                               |
| -------------------- | ---------------------- | ---------------------------- | --------------------------------------- |
| Indexer              | Envio HyperIndex       | Envio hosted                 | `indexer-envio/`                        |
| GraphQL API          | Hasura (auto-managed)  | Envio hosted                 | —                                       |
| Dashboard            | Next.js 16 + Plotly    | Vercel                       | `ui-dashboard/`                         |
| Shared config        | TypeScript             | —                            | `shared-config/`                        |
| Metrics bridge (v3)  | Node 22 + prom-client  | Cloud Run (mento-monitoring) | `metrics-bridge/`                       |
| Aegis (v2)           | NestJS                 | App Engine (mento-prod)      | `../aegis/`                             |
| Grafana Agent        | Docker (grafana/agent) | App Engine (mento-prod)      | `../aegis/grafana-agent/`               |
| Aegis alert rules    | Terraform (HCL)        | Grafana Cloud                | `../aegis/terraform/grafana-alerts/`    |
| Aegis dashboards     | Terraform (HCL)        | Grafana Cloud                | `../aegis/terraform/grafana-dashboard/` |
| v3 alert rules (new) | Terraform (HCL)        | Grafana Cloud                | `terraform/alerts/` (TBD)               |

---

## 3. Networks

| Network       | Chain ID | Status  | Start Block |
| ------------- | -------- | ------- | ----------- |
| Celo Mainnet  | 42220    | ✅ Live | 60664513    |
| Celo Sepolia  | 11142220 | ✅ Live | —           |
| Monad Mainnet | 143      | ✅ Live | —           |

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

| Status   | Condition                                                                      |
| -------- | ------------------------------------------------------------------------------ |
| OK       | `priceDifference / rebalanceThreshold ≤ 1.0`                                   |
| WARN     | ratio > 1.0 (breach) within a 60-min grace window — rebalance is expected      |
| CRITICAL | ratio > 1.0 sustained for > 60 min — breach no longer recoverable by rebalance |

Near-threshold deviations (e.g. 80–100% of threshold) are OK: sitting close
to but under the line is not actionable for the operator. The pool only
escalates when it actually breaches.

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

`effectivenessRatio` per RebalanceEvent = `(priceDifferenceBefore - priceDifferenceAfter) / (priceDifferenceBefore - rebalanceThreshold)` — how much of the **gap to the rebalance boundary** was closed. `1.0` = rebalance landed exactly on the boundary (ideal); `> 1.0` = overshoot past the boundary (e.g. all the way to the oracle midpoint — over-correction that wastes reserves); `< 0` = rebalance made deviation worse.

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

Source of truth: [`indexer-envio/schema.graphql`](./indexer-envio/schema.graphql)

Key entities: `Pool` (mutable per-pool state), `PoolSnapshot` / `PoolDailySnapshot` (hourly/daily aggregates), `OracleSnapshot` (per-event health timeline), `TradingLimit` (per-pool per-token limit state), `RebalanceEvent` (per-rebalance effectiveness).

Pool IDs are namespaced as `{chainId}-{poolAddress}` for multichain support.

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

| Network       | Chain ID | Indexer Status | Dashboard |
| ------------- | -------- | -------------- | --------- |
| Celo Mainnet  | 42220    | Live           | Live      |
| Celo Sepolia  | 11142220 | Live           | Live      |
| Monad Mainnet | 143      | Live           | Live      |

---

## 9. Known Limitations

| Limitation                           | Details                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint hash changes on each deploy | Envio free tier generates new URL per deploy; requires Vercel env var update                                                        |
| Hasura 1000-row cap                  | Envio hosted Hasura silently caps all queries at 1000 rows; use `fetchAllSnapshotPages` or indexer-side rollups                     |
| Cannot run two indexers locally      | Shared Hasura port 8080; use separate Docker projects                                                                               |
| SortedOracles on Sepolia             | Contracts return zero address; oracle indexing mainnet-only                                                                         |
| Gap-fill not yet implemented         | PoolSnapshot charts may show gaps for periods with no activity                                                                      |
| Monad pools pending                  | Pool contracts deployed; indexer config ready                                                                                       |
| No Liquity v2 indexing               | TroveManager / StabilityPool — needed for Stability Pool headroom alerts                                                            |
| v3 alert rules pending               | Metrics pipeline is live (metrics-bridge → Grafana Agent → Grafana Cloud); Terraform rules + Slack contact point are next — see §10 |

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

**Metrics pipeline is live.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls the Envio indexer every 30s and exports `mento_pool_*` Prometheus gauges. Grafana Agent (in the `aegis` repo) scrapes it and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). Verified: 11 FPMM pools across Celo + Monad mainnet reporting with <30s staleness.

**Remaining work:**

1. Create Slack `#alerts-v3` channel + incoming-webhook; stash URL as `TF_VAR_slack_webhook_alerts_v3`
2. Build `terraform/alerts/` in this repo — Grafana provider + Slack contact point + notification policy + 5 rules (see §5 thresholds)
3. Smoke-test by briefly lowering a threshold and confirming Slack fires

**`service` label convention** (matches the existing Aegis pattern of `service = monitored-domain`, not producer):

| `service`        | Covers                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `fpmms`          | FPMM pool alerts (deviation, limits, rebalancer, oracle_ok) — initial PR |
| `metrics-bridge` | Bridge self-monitoring (poll errors, stale polls) — initial PR           |
| `oracles`        | Oracle report outliers (future; distinct from Aegis's `oracle-relayers`) |
| `cdps`           | Stability-pool / CDP (future; blocked on Liquity v2 indexing)            |

All four route to `#alerts-v3` via a single notification-policy regex match `service =~ "fpmms|oracles|cdps|metrics-bridge"`. Split later by severity or additional channels without changing series labels.

**Pipeline topology** (v3 path, as distinct from the Aegis v2 path):

```
Envio Hasura ── (poll 30s) ── metrics-bridge ── /metrics ── Grafana Agent ── remote_write ── Grafana Cloud
 (monitoring-monorepo)          (Cloud Run,            (aegis repo, App      (clabsmento.
                                 mento-monitoring       Engine in             grafana.net)
                                 GCP project)           mento-prod)
```

Image rollouts for the bridge go through `gcloud run services update` (CI uses WIF); Terraform owns service shape only (`lifecycle.ignore_changes` on the image field). Grafana Agent's Dockerfile required four separate fixes (#51–#54 in aegis) before the first successful deploy because the #47 security-hardening pass was never actually built.

## 11. Future Plans

### Next

- **v3 FPMM alert rules** (`terraform/alerts/` module) — oracle liveness, deviation warn/crit, trading limits, rebalancer stale, bridge not reporting. Pipeline already live (see §10).

### Backlog

- Oracle report-outlier alerts (`service=oracles`) — indexer support for historical oracle prices pending
- Liquity v2 CDP indexing (TroveManager, StabilityPool) — unblocks `service=cdps` stability-pool alerts
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

- `ci.yml` — aggregate quality check. `changes` job detects which packages are affected, then fans out to `ui`, `indexer` (codegen + typecheck + test), and `bridge` gated on path changes. `ui` and `bridge` run typecheck + test with coverage uploaded to Codecov. Lint runs repo-wide via the separate `Code Quality` (Trunk) workflow, not duplicated here. A final `ci` sentinel aggregates via `re-actors/alls-green` and is the single required check on `main`.
- `metrics-bridge.yml` — deploy-only (Cloud Run via Terraform) on `push` to `main` with paths filter. Quality is handled by `ci.yml`.
- `infra.yml` — terraform validate, workflow-level path filter.
- `trunk.yml` — repo-wide lint via Trunk; required separately as "Code Quality".
- `notify-envio-deploy.yml` — Discord notification on `deploy/*` push.
- `claude.yml` — `@claude` mention automation.

Branch protection: `CI / ci` + `Code Quality` (Trunk) + Vercel checks required on `main`.
