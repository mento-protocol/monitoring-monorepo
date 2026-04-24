# Monitoring Monorepo — Roadmap

Last updated: 2026-04-24

## Done

### Indexer

- [x] Envio indexer: Celo Sepolia config (VirtualPools + FPMMs)
- [x] Envio indexer: Celo Mainnet config (4 FPMMs + VirtualPools)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] **Monad mainnet live** — start block backfilled; FPMMs indexed
- [x] **Oracle health state** — `healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold` on Pool entity
- [x] **OracleSnapshot entity** — per-event oracle price + health timeline (dual y-axis: price + deviation%)
- [x] SortedOracles events indexed (mainnet: `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`)
- [x] **TradingLimit entity** — `limitStatus`, `limitPressure0/1`, `netflow0/1`, per-pool per-token
- [x] **Rebalancer liveness** — `rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio` on RebalanceEvent
- [x] **Rebalance effectiveness rollup** — `lastEffectivenessRatio` on `Pool` (enables KPI 4 effectiveness alert)
- [x] **PoolSnapshot pre-aggregation** — volume, TVL, fees per pool per hour
- [x] **PoolDailySnapshot rollup** — daily aggregation from hourly snapshots
- [x] Pool cumulative fields: `swapCount`, `notionalVolume0/1`, `rebalanceCount`
- [x] `txHash` on all indexed events
- [x] `@index` directives on schema for query performance
- [x] Deploy branch strategy (`deploy/celo-sepolia`, `deploy/celo-mainnet`)
- [x] Multichain config (`config.multichain.mainnet.yaml`) — Celo (42220) + Monad (143)
- [x] **Deviation breach tracking** — `deviationBreachStartedAt` on Pool entity (rising-edge timestamp)
- [x] **Deviation breach history entity** — first-class per-breach entries with start/end for charting
- [x] **Anchor-based breach deferral** — correct handling of multi-`ReservesUpdated` txs
- [x] **Indexer perf pass** — parallel oracle loops, concurrent RPC+`Pool.get`, memoised rebalancing state, bounded oracle caches (OOM fix)
- [x] **Hardening** — ERC20 fee-token registration gated by Mento registry
- [x] **FX weekend exclusion** — healthscore math excludes FX market closing hours
- [x] FX calendar extracted to `shared-config` package
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors

### Dashboard

- [x] **Live at [monitoring.mento.org](https://monitoring.mento.org)**
- [x] **Global overview page** (`/`) — protocol-wide metrics tiles, all pools table, activity ranking; SSR + slim per-page GraphQL fetches
- [x] **Pool detail page** (`/pools/[poolId]`) — trades table, reserve history chart, analytics tab
- [x] **Pool header v2** — Health Score retired; breaches live in a dedicated tab with timeline chart
- [x] **Analytics tab** — PoolSnapshot charts (hourly swap volume + cumulative count)
- [x] **Oracle health state** — HealthBadge, HealthPanel on pool detail
- [x] **Oracle chart** on analytics tab (FPMM pools only — dual y-axis price + deviation%)
- [x] Pool list with health badge column
- [x] **Fully multichain** — network switcher dropped; all chains shown together with chain icon prefix
- [x] Token symbol mapping via `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component (reused across home + pools pages)
- [x] **CDP strategy badge** on global pools table (stopgap RPC probe — indexer entity pending)
- [x] **LimitBadge + LimitPanel** — `limitStatus` / `limitPressure0/1` from TradingLimit entity
- [x] **RebalancerBadge + RebalancerPanel** — rebalancer liveness status + diagnostics
- [x] **TVL on global page** — TVL-over-time chart + KPI tiles with 24h/7d/30d change %
- [x] **TVL Δ WoW column** on all pools table
- [x] **Protocol Revenue page** (`/revenue`) — swap fee time-series with 24h/7d/30d/all-time breakdowns
- [x] **Daily volume chart** alongside TVL chart on pool detail
- [x] **Bridge-flows page v2** — pagination, status filter, duration column, range tabs, stuck-transfer redeem CTA, route delivery tile, chain icons on sender/receiver
- [x] **Error boundaries + loading skeletons** — route-level error handling
- [x] **SWR backoff + 429 retry gating** — visibility/online-aware polling, reduced Envio rate-limit pressure
- [x] **Google Auth** (NextAuth.js) — restricted to `@mentolabs.xyz` accounts
- [x] **Auth hardening** — verify Google `hd` + `email_verified`, middleware-enforced allowlist, 1h JWT
- [x] **Security** — full CSP + HSTS headers; unauthenticated label endpoints retired; Plotly XSS escape; RSC label-leak guard; callback-URL sanitizer
- [x] **Chain icon prefix** — chain identifier on pool IDs in multichain view

### Shared packages

- [x] **`shared-config` chain + token metadata** — chain names, explorer bases, token symbols, pool-pair labels; replaced duplicated hardcoded maps in bridge + dashboard

### Infrastructure / DX

- [x] CI pipeline — single aggregate `ci.yml` (ESLint 10 + Vitest + typecheck + Codecov) fans out to `ui` / `indexer` / `bridge` via path filter; Trunk `Code Quality` is the only other required check
- [x] **High/critical npm advisory merge-block**
- [x] **CI actions pinned to commit SHAs** (`claude-code-action`, `checkout`)
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — updates Vercel env var via API after indexer redeploy
- [x] **Discord notification on deploy branch push** (`notify-envio-deploy.yml`)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

---

## Alerting — Current State (Aegis v2)

Aegis is **already live** for Mento v2 alerts. It polls on-chain contract state via RPC view calls and exposes Prometheus metrics that Grafana Cloud ingests.

**Live alert rules** (Terraform-managed in `aegis/terraform/grafana-alerts/`):

| Alert Group      | What it monitors                                        | Channels                           |
| ---------------- | ------------------------------------------------------- | ---------------------------------- |
| Oracle Relayers  | Stale price feeds, low CELO balance for relayer wallets | Discord + Splunk On-Call (mainnet) |
| Reserve Balances | Low USDC/USDT/axlUSDC in reserve                        | Discord                            |
| Trading Modes    | Circuit breakers tripped (trading halted per rate feed) | Discord                            |
| Trading Limits   | L0/L1/LG utilization >90%                               | Discord + Splunk On-Call (L1/LG)   |
| Aegis Service    | RPC failures, data staleness                            | Discord + Splunk On-Call           |

**Infrastructure:**

- Aegis NestJS app on GCP App Engine (`mento-prod`)
- Grafana Agent on GCP App Engine → pushes to Grafana Cloud (`clabsmento.grafana.net`)
- 8 Discord webhook contact points + Splunk On-Call for on-call escalation
- Weekend mute timings for FX rate feeds (Fri 22:00 — Sun 22:00 UTC)

---

## v3 Alerting — Live

Metrics pipeline and first-cut alert rules are shipped end-to-end:

- **Pipeline.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls Hasura every 30s and exports `mento_pool_*` gauges. Grafana Agent (aegis repo, App Engine in `mento-prod`) scrapes the bridge and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet reporting with <30s staleness.
- **Terraform module** `terraform/alerts/` — Grafana provider + Slack contact points + alert rules, separate state backend (`gs://mento-terraform-tfstate-6ed6/monitoring-monorepo-alerts`).
- **Slack channels.** Severity-split: `#alerts-critical` (page-worthy) + `#alerts-warnings` (muted by default). Routing uses rule-level `notification_settings` to bypass the Aegis-owned singleton notification policy — no cross-repo coordination needed.

**Live rule groups** (9 rules):

| Service          | Rule                      | Severity | Threshold                                                              |
| ---------------- | ------------------------- | -------- | ---------------------------------------------------------------------- |
| `fpmms`          | Oracle Liveness           | warning  | `(time() - oracle_timestamp) / oracle_expiry > 0.8` for 2m             |
| `fpmms`          | Oracle Down               | critical | `oracle_ok < 0.5` for 1m                                               |
| `fpmms`          | Deviation Breach          | warning  | `deviation_ratio > 1` for 2m                                           |
| `fpmms`          | Deviation Breach Critical | critical | breach active for >3600s                                               |
| `fpmms`          | Trading Limit Pressure    | warning  | `limit_pressure > 0.8` for 5m                                          |
| `fpmms`          | Trading Limit Tripped     | critical | `limit_pressure >= 1` for 2m                                           |
| `fpmms`          | Rebalancer Stale          | critical | 30m+ breach AND 30m+ since last rebalance                              |
| `fpmms`          | Rebalance Effectiveness   | warning  | `avg_over_time(effectiveness[1h]) < 0.2` AND active breach AND ran ≥1× |
| `metrics-bridge` | Not Reporting             | critical | `time() - bridge_last_poll > 90` for 2m                                |
| `metrics-bridge` | Poll Errors               | critical | `rate(poll_errors_total[5m]) > 0` for 3m                               |

### Deferred

- **Oracle report outliers** (`service=oracles`) — large deltas between consecutive reports. Needs indexer to surface historical oracle prices; design still TBD.
- **Stability Pool headroom** (`service=cdps`) — blocked on Liquity v2 CDP indexing.

---

## Next

### Indexer: CDP strategy entity

- [ ] Mirror the `OlsPool` pattern with a `CdpPool` entity registered on `LiquidityStrategyUpdated` when the strategy resolves to `CDPLiquidityStrategy`. Unblocks retiring the runtime RPC probe in `ui-dashboard/src/lib/strategy-detection.ts`.

---

## Backlog

### Indexer Enhancements

- [ ] **Liquity v2 CDP indexing** — unblocks `service=cdps` alerts + the Liquity v2 dashboard instance
  - Events: TroveManager + StabilityPool
  - Contracts: TroveManager `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`, StabilityPool `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
  - Metrics to surface (spec §2): `spDeposits/CollUsdM`, `spMinBufferGbpm` / `spHeadroomGbpm`, `systemColl` / `systemDebt` / `tcr`, `redemptionRate`, ICR distribution (`icrP1` / `icrP5` / `icrP50` / `icrFracBelowMcr` — needs per-Trove scan at rollup time), `liq/redemptionCountCum` + volumes
  - Config reads: `spMinBufferGbpm` is Liquity v2 config, not event-sourced — needs a view-call snapshot path
- [ ] **`turnoverCum` per pool** — cumulative notional over time-weighted TVL (spec §2); needs TWAP-style accumulator on `Pool`
- [ ] **`timeInWarnCum` per pool** — warn-state rollup mirroring the existing `cumulativeCriticalSeconds`
- [ ] **ChainStat / GlobalStat aggregate entities** — protocol-level metrics; sources `chainProtocolFeesCum` / `globalProtocolFeesCum`
- [ ] **Oracle report history** — unblocks oracle-outlier alerts
- [ ] **`lastOracleUpdateTxHash` on `Pool`** — unblocks tx-link enrichment in Slack alerts

### Dashboard Backlog

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer
- [ ] **Pool detail config snapshot panel** — consolidated view of configured thresholds (rebalance threshold, oracle expiry, trading-limit windows, rebalancer address). Scattered today; spec §4 "Pool" calls for a single config widget.

### Alerting Backlog

- [ ] **Migrate Aegis v2 alerts to Slack** — currently Discord; unify after v3 channel pair soaks

### Infrastructure Backlog

- [ ] **Merge Aegis into the monorepo** — pull `../aegis/` under `services/aegis/`, fold its Terraform into this repo's `terraform/` tree, retire the standalone repo once App Engine deploys run from monorepo CI
- [ ] **Grafana Agent → Alloy migration** — Agent reached EOL 2025-11-01. Alloy is the OTel-collector successor. Run `alloy convert` against `../aegis/grafana-agent/agent.yaml.tmpl`, swap the App Engine image, verify scrape jobs still remote-write. Best sequenced _after_ Aegis merges into the monorepo so the Alloy config lives alongside the services it scrapes.

### Future

- [ ] **Streamlit sandbox** — Python/Streamlit app on same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Hasura/Postgres

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
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

1. **Dashboard path**: Envio indexes on-chain events into Postgres → Hasura exposes GraphQL → Next.js dashboard renders
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → exposes `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Discord + Splunk On-Call
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → exports `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-critical` + `#alerts-warnings` (severity-split)

## Key Files

| What                | Where                                          |
| ------------------- | ---------------------------------------------- |
| Indexer schema      | `indexer-envio/schema.graphql`                 |
| Event handlers      | `indexer-envio/src/EventHandlers.ts`           |
| Multichain config   | `indexer-envio/config.multichain.mainnet.yaml` |
| Mainnet config      | `indexer-envio/config.multichain.mainnet.yaml` |
| Dashboard app       | `ui-dashboard/src/app/`                        |
| Network defs        | `ui-dashboard/src/lib/networks.ts`             |
| GraphQL queries     | `ui-dashboard/src/lib/queries.ts`              |
| Pool type helper    | `ui-dashboard/src/lib/tokens.ts`               |
| FX calendar         | `shared-config/fx-calendar.json`               |
| Technical spec      | `SPEC.md`                                      |
| Deployment guide    | `docs/deployment.md`                           |
| Aegis config        | `../aegis/config.yaml`                         |
| Aegis alert rules   | `../aegis/terraform/grafana-alerts/`           |
| Aegis dashboards    | `../aegis/terraform/grafana-dashboard/`        |
| v3 metrics bridge   | `metrics-bridge/`                              |
| v3 agent scrape cfg | `../aegis/grafana-agent/agent.yaml.tmpl`       |
| v3 alert rules      | `terraform/alerts/`                            |
