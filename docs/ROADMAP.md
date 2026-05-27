# Monitoring Monorepo — Roadmap

Last updated: 2026-05-18

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
- [x] **Liquity v2 CDP indexing substrate** — Celo CDP contract declarations, vendored ABIs, Trove/StabilityPool/instance entities, and CdpPool linkage rows

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
- [x] **CDP strategy badge** on global pools table (runtime RPC probe; indexed CdpPool cutover pending backfill)
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
- [x] **CDPs dashboard routes** — `/cdps` market overview and `/cdps/[symbol]` detail views backed by Liquity v2 GraphQL queries

### Shared packages

- [x] **`shared-config` chain + token metadata** — chain names, explorer bases, token symbols, pool-pair labels; replaced duplicated hardcoded maps in bridge + dashboard

### Infrastructure / DX

- [x] CI pipeline — single aggregate `ci.yml` (ESLint 10 + Vitest + typecheck + Codecov) fans out to `ui` / `indexer` / `bridge` via path filter; Trunk `Code Quality` is the only other required check
- [x] **High/critical npm advisory merge-block**
- [x] **CI actions pinned to commit SHAs** (`claude-code-action`, `checkout`)
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — updates Vercel env var via API after indexer redeploy
- [x] **Envio deploy notification** — replaced by Envio's native Slack integration on the hosted indexer (the `notify-envio-deploy.yml` workflow was removed alongside)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

---

## Alerting — Current State (Aegis v2)

Aegis is **already live** for Mento v2 alerts. It polls on-chain contract state via RPC view calls and exposes Prometheus metrics that Grafana Cloud ingests.

**Live alert rules** (Terraform-managed in `aegis/terraform/grafana-alerts/`):

| Alert Group      | What it monitors                                        | Channels                                                                   |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Oracle Relayers  | Stale price feeds, low CELO balance for relayer wallets | Slack #alerts-oracles + #alerts-critical/Splunk (page, celo)               |
| Reserve Balances | Low USDC/USDT/axlUSDC in reserve                        | Slack #alerts-reserve                                                      |
| Trading Modes    | Circuit breakers tripped (trading halted per rate feed) | Slack #alerts-critical/Splunk (page, celo); #alerts-testnet (celo-sepolia) |
| Trading Limits   | L0/L1/LG utilization >90%                               | Slack #alerts-pools (L0); #alerts-critical/Splunk (L1/LG, page)            |
| Aegis Service    | RPC failures, data staleness                            | Slack #alerts-infra; #alerts-critical/Splunk (page)                        |

Currently dual-routed alongside the legacy Discord channels during the migration soak window; the cutover PR removes the Discord side once parity is verified.

**Infrastructure:**

- Aegis NestJS app on GCP App Engine (`mento-monitoring`)
- Grafana Agent on GCP App Engine → pushes to Grafana Cloud (`clabsmento.grafana.net`)
- Slack contact points (6) + Splunk On-Call for on-call escalation, Discord webhooks retained during dual-route soak
- Weekend mute timings for FX rate feeds (Fri 21:00 — Sun 21:00 UTC) preserved on every Slack page/warning route

---

## v3 Alerting — Live

Metrics pipeline and first-cut alert rules are shipped end-to-end:

- **Pipeline.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls Hasura every 30s and exports `mento_pool_*` gauges. Grafana Agent (`aegis/grafana-agent/`, App Engine in `mento-monitoring`) scrapes the bridge and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet reporting with <30s staleness.
- **Terraform module** `alerts/rules/` — Grafana provider + Slack contact points + alert rules, separate state backend (`gs://mento-terraform-tfstate-6ed6/alerts-rules`).
- **Slack channels.** Domain-split: `#alerts-critical` (page-worthy across services) + per-domain warning channels (`#alerts-oracles`, `#alerts-pools`, `#alerts-infra`). Aegis dual-route additionally lands in `#alerts-reserve` (reserve balance) and `#alerts-testnet` (any non-prod chain). Routing uses rule-level `notification_settings` to bypass the Aegis-owned singleton notification policy — no cross-repo coordination needed for v3.

**Live FPMM + bridge rule inventory:**

| Service          | Rule                                    | Severity | Threshold                                                           |
| ---------------- | --------------------------------------- | -------- | ------------------------------------------------------------------- |
| `fpmms`          | Oracle Liveness                         | warning  | liveness ratio `> 1.2` for 2m (FX-weekend gated)                    |
| `fpmms`          | Oracle Down                             | critical | `oracle_ok < 0.5` for 1m                                            |
| `fpmms`          | Oracle Liveness Critical                | critical | liveness ratio `> 3` for 1m (FX-weekend gated)                      |
| `fpmms`          | Deviation Breach                        | warning  | `deviation_ratio > 1.01` for 15m (above 1% tolerance)               |
| `fpmms`          | Deviation Breach (anchored)             | warning  | anchored breach + deviation-ratio data unavailable for 15m          |
| `fpmms`          | Deviation Breach Critical               | critical | breach >3600s AND `deviation_ratio > 1.05` (magnitude + duration)   |
| `fpmms`          | Deviation Breach Critical (anchored)    | critical | breach >3600s AND deviation-ratio data unavailable                  |
| `fpmms`          | Deviation Breach State Changed          | warning  | recent warning-tier deviation state transition                      |
| `fpmms`          | Deviation Breach Critical State Changed | critical | recent critical-tier deviation state transition                     |
| `fpmms`          | Trading Limit Pressure                  | warning  | `limit_pressure > 0.8` for 5m                                       |
| `fpmms`          | Trading Limit Tripped                   | critical | `limit_pressure >= 1` for 2m                                        |
| `fpmms`          | Rebalancer Stale                        | critical | 1h+ breach AND 30m+ since last rebalance; FX weekend + reopen-gated |
| `fpmms`          | Rebalance Effectiveness                 | warning  | last in-breach rebalance closed <50% of gap-to-boundary, `for=15m`  |
| `metrics-bridge` | Not Reporting                           | critical | `time() - bridge_last_poll > 90` for 2m                             |
| `metrics-bridge` | Poll Errors                             | critical | `rate(poll_errors_total[5m]) > 0` for 3m                            |

### Deferred

- **Oracle report outliers** (`service=oracles`) — large deltas between consecutive reports. Needs indexer to surface historical oracle prices; design still TBD.
- **Stability Pool headroom** (`service=cdps`) — blocked on production CDP backfill and alert-rule rollout.

---

## Next

### CDP Monitoring Rollout

- [ ] Deploy and backfill the Liquity v2 Celo indexer changes, promote the synced deployment, and verify hosted Hasura exposes the CDP schema before production dashboard rollout.
- [ ] Cut the global pools table from the RPC strategy probe to indexed `CdpPool` rows once all CDP-capable networks have strategy events indexed or an explicit fallback.

---

## Backlog

### Indexer Enhancements

- [ ] **CDP live risk refinements** — compute live TCR/ICR percentiles from accrued interest and add a governance-owned stability-pool buffer source if headroom should be measured against a non-zero target.
- [ ] **`turnoverCum` per pool** — cumulative notional over time-weighted TVL (spec §2); needs TWAP-style accumulator on `Pool`
- [ ] **`timeInWarnCum` per pool** — warn-state rollup mirroring the existing `cumulativeCriticalSeconds`
- [ ] **ChainStat / GlobalStat aggregate entities** — protocol-level metrics; sources `chainProtocolFeesCum` / `globalProtocolFeesCum`
- [ ] **Oracle report history** — unblocks oracle-outlier alerts
- [ ] **`lastOracleUpdateTxHash` on `Pool`** — unblocks tx-link enrichment in Slack alerts

### Dashboard Backlog

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer
- [ ] **Pool detail config snapshot panel** — consolidated view of configured thresholds (rebalance threshold, oracle expiry, trading-limit windows, rebalancer address). Scattered today; spec §4 "Pool" calls for a single config widget.

### Alerting Backlog

- [ ] **Cut over Aegis v2 alerts to Slack-only** — dual-route soak window in progress on this PR; cutover PR removes Discord side once parity is verified

### Infrastructure Backlog

- [x] **Merge Aegis into the monorepo** — top-level `aegis/` workspace package; App Engine deploy workflow, Grafana Agent, Discord/Splunk routing, and Terraform backend prefix preserved
- [x] **Move Aegis runtime into `mento-monitoring`** — App Engine default service and Grafana Agent now live with the rest of the monitoring GCP resources
- [ ] **Grafana Agent → Alloy migration** — Agent reached EOL 2025-11-01. Alloy is the OTel-collector successor. Run `alloy convert` against `aegis/grafana-agent/agent.yaml.tmpl`, swap the App Engine image, verify scrape jobs still remote-write.

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
│ (Vercel)  │ │  mento-        │        │   aegis/)            │
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
                │ Discord (Aegis v2, soak window)   │
                └───────────────────────────────────┘
```

**Three data paths share a common Grafana Cloud + Grafana Agent stack:**

1. **Dashboard path**: Envio indexes on-chain events into Postgres → Hasura exposes GraphQL → Next.js dashboard renders
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → exposes `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Slack `#alerts-critical` + per-domain warning channels + Splunk On-Call (page severity); Discord dual-route stays live during the migration soak window
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → exports `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-critical` (page-worthy) + per-domain warning channels (`#alerts-oracles` / `#alerts-pools` / `#alerts-infra`)

## Key Files

| What                | Where                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| Indexer schema      | `indexer-envio/schema.graphql`                                                   |
| Event handlers      | `indexer-envio/src/EventHandlers.ts`                                             |
| Multichain config   | `indexer-envio/config.multichain.mainnet.yaml`                                   |
| Mainnet config      | `indexer-envio/config.multichain.mainnet.yaml`                                   |
| Dashboard app       | `ui-dashboard/src/app/`                                                          |
| Network defs        | `ui-dashboard/src/lib/networks.ts`                                               |
| GraphQL queries     | `ui-dashboard/src/lib/queries.ts` (barrel) + `ui-dashboard/src/lib/queries/*.ts` |
| Pool type helper    | `ui-dashboard/src/lib/tokens.ts`                                                 |
| FX calendar         | `shared-config/fx-calendar.json`                                                 |
| Technical spec      | `SPEC.md`                                                                        |
| Deployment guide    | `docs/deployment.md`                                                             |
| Aegis config        | `aegis/config.yaml`                                                              |
| Aegis alert rules   | `aegis/terraform/grafana-alerts/`                                                |
| Aegis dashboards    | `aegis/terraform/grafana-dashboard/`                                             |
| v3 metrics bridge   | `metrics-bridge/`                                                                |
| v3 agent scrape cfg | `aegis/grafana-agent/agent.yaml.tmpl`                                            |
| v3 alert rules      | `alerts/rules/`                                                                  |
