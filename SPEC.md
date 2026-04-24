# Mento v3 Monitoring — Technical Specification

Last updated: 2026-04-24

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
                ┌────────────┴──────────────────┐
                │ Discord (Aegis v2)            │
                │ Splunk On-Call                │
                │ Slack #alerts-critical (v3)   │
                │ Slack #alerts-warnings (v3)   │
                └───────────────────────────────┘
```

**Three data paths share a common Grafana Cloud + Grafana Agent stack:**

1. **Dashboard path**: Envio indexes on-chain events → Hasura GraphQL → Next.js dashboard
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Discord + Splunk On-Call
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-critical` + `#alerts-warnings` (rules in `terraform/alerts/`)

### Components

| Component           | Technology             | Hosting                      | Repo Path                               |
| ------------------- | ---------------------- | ---------------------------- | --------------------------------------- |
| Indexer             | Envio HyperIndex       | Envio hosted                 | `indexer-envio/`                        |
| GraphQL API         | Hasura (auto-managed)  | Envio hosted                 | —                                       |
| Dashboard           | Next.js 16 + Plotly    | Vercel                       | `ui-dashboard/`                         |
| Shared config       | TypeScript             | —                            | `shared-config/`                        |
| Metrics bridge (v3) | Node 22 + prom-client  | Cloud Run (mento-monitoring) | `metrics-bridge/`                       |
| Aegis (v2)          | NestJS                 | App Engine (mento-prod)      | `../aegis/`                             |
| Grafana Agent       | Docker (grafana/agent) | App Engine (mento-prod)      | `../aegis/grafana-agent/`               |
| Aegis alert rules   | Terraform (HCL)        | Grafana Cloud                | `../aegis/terraform/grafana-alerts/`    |
| Aegis dashboards    | Terraform (HCL)        | Grafana Cloud                | `../aegis/terraform/grafana-dashboard/` |
| v3 alert rules      | Terraform (HCL)        | Grafana Cloud                | `terraform/alerts/`                     |

---

## 3. Networks

| Network       | Chain ID | Status  | Start Block |
| ------------- | -------- | ------- | ----------- |
| Celo Mainnet  | 42220    | ✅ Live | 60664513    |
| Celo Sepolia  | 11142220 | ✅ Live | —           |
| Monad Mainnet | 143      | ✅ Live | backfilled  |

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

### 5.4 Rebalancer Liveness + Effectiveness

**What:** Two halves — does the rebalancer _fire_ when the pool is deviated (liveness), and when it fires does it actually _fix_ the deviation (effectiveness)?

**Fields:** `rebalancerAddress`, `rebalanceLivenessStatus`, `lastRebalancedAt`, `lastEffectivenessRatio` on Pool; `effectivenessRatio` on RebalanceEvent; `rebalanceCount` cumulative.

**Applies to:** FPMM pools only

| Status | Condition                          |
| ------ | ---------------------------------- |
| ACTIVE | Rebalancer has rebalanced recently |
| N/A    | Pool is a VirtualPool              |

`effectivenessRatio` per RebalanceEvent = `(priceDifferenceBefore - priceDifferenceAfter) / priceDifferenceBefore` — how much of the deviation was corrected. Range: `1.0` = fully closed, `0.5` = halved, `0` = no effect, `< 0` = moved _away_ from oracle.

`Pool.lastEffectivenessRatio` mirrors the most recent event's ratio so the bridge can emit it as a single gauge without a subquery. Alert rule: rolling 1h avg <0.2 AND active breach AND ≥1 rebalance in window (catches persistent control-loop failure, ignores one-off MEV hits).

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

Key entities: `Pool` (mutable per-pool state, incl. `lastEffectivenessRatio` + `deviationBreachStartedAt`), `PoolSnapshot` / `PoolDailySnapshot` (hourly/daily aggregates), `OracleSnapshot` (per-event health timeline), `TradingLimit` (per-pool per-token limit state), `RebalanceEvent` (per-rebalance effectiveness), `DeviationBreach` (first-class per-breach history with start/end).

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

Per-pool deep-dive. The pool header displays the current health/limit/rebalancer badges (the old numeric "Health Score" was retired — breaches now live on a dedicated tab).

**Tabs:**

1. **Overview** — reserve chart (Plotly), recent swaps table
2. **Analytics** — PoolSnapshot charts (hourly volume bars + cumulative count), OracleChart (FPMM only), daily volume chart
3. **Breaches** — per-breach history chart sourced from the `DeviationBreach` entity (FPMM only)
4. **Limits** — LimitPanel with trading limit pressure per token
5. **Rebalancer** — RebalancerPanel with liveness status + diagnostics

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

NextAuth.js with Google provider. Domain-restricted to `@mentolabs.xyz` via `hd` + `email_verified` verification in the JWT callback and middleware-enforced allowlist. JWT session strategy with 1h max age. Custom sign-in page at `/sign-in`. Callback URLs sanitized server-side to block open-redirect; RSC label-leak guard covers the `/api/labels/*` and similar routes.

Full CSP and HSTS (with preload) headers shipped; unauthenticated GET endpoints on address labels have been retired.

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

| Limitation                             | Details                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint hash changes on each deploy   | Envio free tier generates new URL per deploy; requires Vercel env var update                                                       |
| Hasura 1000-row cap                    | Envio hosted Hasura silently caps all queries at 1000 rows; use `fetchAllSnapshotPages` or indexer-side rollups                    |
| Cannot run two indexers locally        | Shared Hasura port 8080; use separate Docker projects                                                                              |
| SortedOracles on Sepolia               | Contracts return zero address; oracle indexing mainnet-only                                                                        |
| Gap-fill not yet implemented           | PoolSnapshot charts may show gaps for periods with no activity                                                                     |
| No Liquity v2 indexing                 | TroveManager / StabilityPool — needed for Stability Pool headroom alerts                                                           |
| CDP strategy detection is an RPC probe | `ui-dashboard/src/lib/strategy-detection.ts` probes strategy addresses at runtime. Indexer `CdpPool` entity pending — see BACKLOG. |

---

## 10. Alerting

### Aegis v2 (live)

Aegis polls v2 contract state via RPC every 10-60s and exposes Prometheus metrics that Grafana Cloud ingests. All Grafana resources (dashboards, alert rules, contact points, notification policies) are Terraform-managed in the aegis repo.

| Group            | Rules                               | Notification Channels              |
| ---------------- | ----------------------------------- | ---------------------------------- |
| Oracle Relayers  | Stale price feeds, low CELO balance | Discord + Splunk On-Call (mainnet) |
| Reserve Balances | Low USDC/USDT/axlUSDC               | Discord                            |
| Trading Modes    | Circuit breakers tripped            | Discord                            |
| Trading Limits   | L0/L1/LG utilization >90%           | Discord + Splunk On-Call (L1/LG)   |
| Aegis Service    | RPC failures, data staleness        | Discord + Splunk On-Call           |

### v3 FPMM Alerts (live)

**Pipeline.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls the Envio indexer every 30s and exports `mento_pool_*` Prometheus gauges. Grafana Agent (aegis repo, App Engine in `mento-prod`) scrapes and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet reporting with <30s staleness.

**Terraform module** `terraform/alerts/` — Grafana provider, Slack contact points, and per-rule `notification_settings`. Separate state backend (`gs://mento-terraform-tfstate-6ed6/monitoring-monorepo-alerts`). Uses rule-level `notification_settings` rather than the Aegis-owned singleton notification policy, so no cross-repo coordination required.

**Slack channels.** Severity-split, not domain-split:

| Channel            | Use                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `#alerts-critical` | Page-worthy — deviation-critical, oracle-down, limit-tripped, rebalancer-stale, bridge-not-reporting |
| `#alerts-warnings` | Muted by default; opened when investigating                                                          |

Domain-split (`#alerts-v3`) was the original plan but `critical` vs `warning` is the axis operators actually toggle on. Per-domain splits can be layered later without relabelling series.

**Rules shipped** (9 rules across 2 services — see `terraform/alerts/rules-*.tf`):

| Service          | Rule                      | Severity | Expression                                                                                                                               |
| ---------------- | ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fpmms`          | Oracle Liveness           | warning  | `(time() - mento_pool_oracle_timestamp) / mento_pool_oracle_expiry > 0.8` for 2m                                                         |
| `fpmms`          | Oracle Down               | critical | `mento_pool_oracle_ok < 0.5` for 1m                                                                                                      |
| `fpmms`          | Deviation Breach          | warning  | `mento_pool_deviation_ratio > 1` for 2m                                                                                                  |
| `fpmms`          | Deviation Breach Critical | critical | breach active >3600s (indexer-anchored via `deviationBreachStartedAt`)                                                                   |
| `fpmms`          | Trading Limit Pressure    | warning  | `max(mento_pool_limit_pressure) > 0.8` for 5m                                                                                            |
| `fpmms`          | Trading Limit Tripped     | critical | `max(mento_pool_limit_pressure) >= 1` for 2m                                                                                             |
| `fpmms`          | Rebalancer Stale          | critical | 30m+ breach AND 30m+ since last rebalance                                                                                                |
| `fpmms`          | Rebalance Effectiveness   | warning  | `avg_over_time(mento_pool_rebalance_effectiveness[1h]) < 0.2` AND breach active AND `increase(rebalance_count_total[1h]) > 0`, `for=15m` |
| `metrics-bridge` | Not Reporting             | critical | `time() - mento_pool_bridge_last_poll > 90` for 2m                                                                                       |
| `metrics-bridge` | Poll Errors               | critical | `rate(mento_pool_bridge_poll_errors_total[5m]) > 0` for 3m                                                                               |

**`service` label convention** (matches the existing Aegis pattern of `service = monitored-domain`, not producer):

| `service`        | Covers                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `fpmms`          | FPMM pool alerts — live                                                  |
| `metrics-bridge` | Bridge self-monitoring — live                                            |
| `oracles`        | Oracle report outliers (backlog; needs indexer historical oracle prices) |
| `cdps`           | Stability-pool / CDP (backlog; blocked on Liquity v2 indexing)           |

**Pipeline topology** (v3 path, distinct from the Aegis v2 path):

```
Envio Hasura ── (poll 30s) ── metrics-bridge ── /metrics ── Grafana Agent ── remote_write ── Grafana Cloud
 (monitoring-monorepo)          (Cloud Run,            (aegis repo, App      (clabsmento.
                                 mento-monitoring       Engine in             grafana.net)
                                 GCP project)           mento-prod)
```

**Operational notes.**

- Bridge image rollouts: `gcloud run services update` via CI (WIF-auth, no long-lived keys). Terraform owns service shape only (`lifecycle.ignore_changes` on image). Rollbacks are self-describing — `--revision-suffix=<sha>-<run-id>`.
- Bridge health probe lives at `/health` (Cloud Run v2 reserves `/healthz`).
- Bridge deploy SA needs `serviceusage.serviceUsageConsumer` + `logging.logWriter`; the `mento-monitoring` bootstrap SA needs project owner.
- Grafana Agent Dockerfile took four sequential fixes (aegis #51-#54) before the first healthy rollout.

## 11. Future Plans

### Next

- **Indexer `CdpPool` entity** — mirror `OlsPool`, registered on `LiquidityStrategyUpdated` when the strategy resolves to `CDPLiquidityStrategy`. Unblocks retiring the runtime RPC probe in `ui-dashboard/src/lib/strategy-detection.ts`.

### Backlog

- Oracle report-outlier alerts (`service=oracles`) — indexer support for historical oracle prices pending
- Liquity v2 CDP indexing (TroveManager, StabilityPool) — unblocks `service=cdps` stability-pool alerts
- `lastOracleUpdateTxHash` on `Pool` — unblocks tx-link enrichment in Slack alerts
- ChainStat / GlobalStat aggregate entities
- Gap-fill logic for snapshot charts
- Migrate Aegis v2 alerts onto the new Slack channel pair (currently Discord)
- Merge Aegis into the monorepo — retire the sibling `../aegis/` repo, fold its Terraform into `terraform/`
- Grafana Agent → Grafana Alloy — Agent reached EOL on 2025-11-01; Alloy is the OTel-collector successor
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
