# Mento v3 Monitoring — Technical Specification

Last updated: 2026-04-24

---

## 1. System Overview

The Mento v3 monitoring system provides real-time visibility into Mento's on-chain FX protocol on Celo. It indexes on-chain events from FPMM pools, oracle contracts, and factory contracts, then exposes them through a GraphQL API and a public dashboard.

### Goals

1. **Operational awareness** — pool health, oracle liveness, trading limit pressure, rebalancer liveness
2. **Trade analytics** — volume, TVL, fee revenue per pool over time
3. **Alerting** — proactive alerts when KPIs breach thresholds (Aegis v2 + v3 FPMM alerts both live, both routed to Slack)
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
                ┌────────────┴──────────────────────┐
                │ Splunk On-Call (page severity)    │
                │ Slack #alerts-critical            │
                │ Slack #alerts-oracles / -pools /  │
                │       -infra / -reserve / -testnet│
                └───────────────────────────────────┘
```

**Three data paths share a common Grafana Cloud + Grafana Agent stack:**

1. **Dashboard path**: Envio indexes on-chain events → Hasura GraphQL → Next.js dashboard
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Slack `#alerts-critical` + per-domain warning channels + Splunk On-Call (page severity)
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-critical` (page-worthy) + per-domain warning channels (`#alerts-oracles` / `#alerts-pools` / `#alerts-infra`) — rules in `alerts/rules/`

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
| v3 alert rules      | Terraform (HCL)        | Grafana Cloud                | `alerts/rules/`                         |

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

### 5.5 Stability Pool Headroom (Phase 2)

**What:** Is there enough collateral in the Stability Pool to absorb liquidations?

**Fields:** `LiquityInstance.spDeposits`, `spColl`, `spHeadroom`,
`systemColl`, `systemDebt`, `tcrBps`, `currentRedemptionRateBps`,
`activeTroveCount`, `icrP1Bps`, `icrP5Bps`, `icrP50Bps`,
`icrFracBelowMcrBps`, `liqCountCum`, `liqDebtOffsetCum`,
`redemptionCountCum`, `redemptionDebtCum`, plus hourly/daily
`LiquityInstanceSnapshot` buckets.

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

| Limitation                             | Details                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint hash changes on each deploy   | Envio free tier generates new URL per deploy; requires Vercel env var update                                                           |
| Hasura 1000-row cap                    | Envio hosted Hasura silently caps all queries at 1000 rows; use `fetchAllSnapshotPages` or indexer-side rollups                        |
| Cannot run two indexers locally        | Shared Hasura port 8080; use separate Docker projects                                                                                  |
| SortedOracles on Sepolia               | Contracts return zero address; oracle indexing mainnet-only                                                                            |
| Gap-fill not yet implemented           | PoolSnapshot charts may show gaps for periods with no activity                                                                         |
| CDP indexer not yet backfilled in prod | New TroveManager / StabilityPool entities need branch deploy, sync, promotion, and hosted Hasura verification before alert rollout     |
| CDP strategy detection is an RPC probe | Global pools table still probes strategy addresses at runtime until indexed `CdpPool` rows are backfilled on every CDP-capable network |

---

## 10. Alerting

### Aegis v2 (live)

Aegis polls v2 contract state via RPC every 10-60s and exposes Prometheus metrics that Grafana Cloud ingests. All Grafana resources (dashboards, alert rules, contact points, notification policies) are Terraform-managed in the aegis repo.

Slack is the active delivery path; page-severity alerts still escalate through Splunk On-Call.

| Group            | Rules                               | Notification Channels                                                      |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Oracle Relayers  | Stale price feeds, low CELO balance | Slack #alerts-oracles + #alerts-critical/Splunk (page, celo)               |
| Reserve Balances | Low USDC/USDT/axlUSDC               | Slack #alerts-reserve                                                      |
| Trading Modes    | Circuit breakers tripped            | Slack #alerts-critical/Splunk (page, celo); #alerts-testnet (celo-sepolia) |
| Trading Limits   | L0/L1/LG utilization >90%           | Slack #alerts-pools (L0); #alerts-critical/Splunk (L1/LG, page)            |
| Aegis Service    | RPC failures, data staleness        | Slack #alerts-infra; #alerts-critical/Splunk (page)                        |

### v3 FPMM Alerts (live)

**Pipeline.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls the Envio indexer every 30s and exports `mento_pool_*` Prometheus gauges. Grafana Agent (aegis repo, App Engine in `mento-prod`) scrapes and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet reporting with <30s staleness.

**Terraform module** `alerts/rules/` — Grafana provider, Slack contact points, and per-rule `notification_settings`. Separate state backend (`gs://mento-terraform-tfstate-6ed6/alerts-rules`). Uses rule-level `notification_settings` rather than the Aegis-owned singleton notification policy, so no cross-repo coordination required.

**Slack channels.** Domain-split warnings + cross-service critical channel:

| Channel            | Use                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `#alerts-critical` | Page-worthy — deviation-critical, oracle-down, limit-tripped, rebalancer-stale, bridge-not-reporting |
| `#alerts-oracles`  | Oracle warnings — liveness, oracle jump above swap fee                                               |
| `#alerts-pools`    | Pool-mechanics warnings — deviation, rebalancer effectiveness, trading-limit pressure                |
| `#alerts-infra`    | Service-infra warnings — indexer, metrics-bridge, Aegis service health                               |

Protocol/Aegis routing additionally uses `#alerts-reserve` (reserve balance) and `#alerts-testnet` (any non-prod chain). Initial rollout was severity-split (`#alerts-warnings` catch-all); refined to per-domain channels once operators wanted to mute/focus by service.

**Rules shipped** (10 rules across 2 services — see `alerts/rules/rules-*.tf`):

| Service          | Rule                                 | Severity | Expression                                                                                                                               |
| ---------------- | ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fpmms`          | Oracle Liveness                      | warning  | `(time() - mento_pool_oracle_timestamp) / mento_pool_oracle_expiry > 1.2` for 2m (FX-weekend gated)                                      |
| `fpmms`          | Oracle Down                          | critical | `mento_pool_oracle_ok < 0.5` for 1m                                                                                                      |
| `fpmms`          | Oracle Liveness Critical             | critical | liveness ratio > 3 for 1m (FX-weekend gated)                                                                                             |
| `fpmms`          | Deviation Breach                     | warning  | `mento_pool_deviation_ratio > 1.01` for 15m (above 1% tolerance)                                                                         |
| `fpmms`          | Deviation Breach (anchored)          | warning  | breach anchored AND ratio gauge missing (`-1` sentinel) for 15m                                                                          |
| `fpmms`          | Deviation Breach Critical            | critical | breach active >3600s AND `mento_pool_deviation_ratio > 1.05` (5% over) — both magnitude and duration gates required                      |
| `fpmms`          | Deviation Breach Critical (anchored) | critical | breach active >3600s AND ratio gauge missing — fallback for the metrics-bridge data-gap window                                           |
| `fpmms`          | Trading Limit Pressure               | warning  | `max(mento_pool_limit_pressure) > 0.8` for 5m                                                                                            |
| `fpmms`          | Trading Limit Tripped                | critical | `max(mento_pool_limit_pressure) >= 1` for 2m                                                                                             |
| `fpmms`          | Rebalancer Stale                     | critical | 30m+ breach AND 30m+ since last rebalance                                                                                                |
| `fpmms`          | Rebalance Effectiveness              | warning  | `avg_over_time(mento_pool_rebalance_effectiveness[1h]) < 0.2` AND breach active AND `increase(rebalance_count_total[1h]) > 0`, `for=15m` |
| `metrics-bridge` | Not Reporting                        | critical | `time() - mento_pool_bridge_last_poll > 90` for 2m                                                                                       |
| `metrics-bridge` | Poll Errors                          | critical | `rate(mento_pool_bridge_poll_errors_total[5m]) > 0` for 3m                                                                               |

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

- **CDP production rollout** — deploy and backfill the Liquity v2 indexer changes, promote the synced deployment, verify hosted Hasura exposes the CDP entities, then enable production dashboard and alert consumption.
- **Global CDP badge cutover** — replace the runtime RPC probe with indexed `CdpPool` rows after all CDP-capable networks have strategy events indexed or a documented fallback.

### Backlog

- Oracle report-outlier alerts (`service=oracles`) — indexer support for historical oracle prices pending
- `service=cdps` alert rules for stability-pool headroom, shutdowns, liquidations, redemptions, and shortfall subsidies
- `lastOracleUpdateTxHash` on `Pool` — unblocks tx-link enrichment in Slack alerts
- ChainStat / GlobalStat aggregate entities
- Gap-fill logic for snapshot charts
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
- Envio deploy notifications come from Envio's native Slack integration on the hosted indexer (the in-repo `notify-envio-deploy.yml` workflow was removed once the hosted integration shipped).
- `claude.yml` — `@claude` mention automation.

Branch protection: `CI / ci` + `Code Quality` (Trunk) + Vercel checks required on `main`.
