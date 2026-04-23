# Monitoring Monorepo — Roadmap

Last updated: 2026-04-23

## Done

### Indexer

- [x] Envio indexer: Celo Sepolia config (VirtualPools + FPMMs)
- [x] Envio indexer: Celo Mainnet config (4 FPMMs + VirtualPools)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] **Oracle health state** — `healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold` on Pool entity
- [x] **OracleSnapshot entity** — per-event oracle price + health timeline (dual y-axis: price + deviation%)
- [x] SortedOracles events indexed (mainnet: `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`)
- [x] **TradingLimit entity** — `limitStatus`, `limitPressure0/1`, `netflow0/1`, per-pool per-token
- [x] **Rebalancer liveness** — `rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio` on RebalanceEvent
- [x] **PoolSnapshot pre-aggregation** — volume, TVL, fees per pool per hour
- [x] **PoolDailySnapshot rollup** — daily aggregation from hourly snapshots
- [x] Pool cumulative fields: `swapCount`, `notionalVolume0/1`, `rebalanceCount`
- [x] `txHash` on all indexed events
- [x] `@index` directives on schema for query performance
- [x] Deploy branch strategy (`deploy/celo-sepolia`, `deploy/celo-mainnet`)
- [x] Multichain config (`config.multichain.mainnet.yaml`) — Celo (42220) + Monad (143)
- [x] **Deviation breach tracking** — `deviationBreachStartedAt` on Pool entity (rising-edge timestamp)
- [x] **FX weekend exclusion** — healthscore math excludes FX market closing hours
- [x] FX calendar extracted to `shared-config` package
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors

### Dashboard

- [x] **Live at [monitoring.mento.org](https://monitoring.mento.org)**
- [x] **Global overview page** (`/`) — protocol-wide metrics tiles, all pools table, activity ranking
- [x] **Pool detail page** (`/pools/[poolId]`) — trades table, reserve history chart, analytics tab
- [x] **Analytics tab** — PoolSnapshot charts (hourly swap volume + cumulative count)
- [x] **Oracle health state** — HealthBadge, HealthPanel on pool detail
- [x] **Oracle chart** on analytics tab (FPMM pools only — dual y-axis price + deviation%)
- [x] Pool list with health badge column
- [x] **Fully multichain** — network switcher dropped; all chains shown together with chain icon prefix
- [x] Token symbol mapping via `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component (reused across home + pools pages)
- [x] **LimitBadge + LimitPanel** — `limitStatus` / `limitPressure0/1` from TradingLimit entity
- [x] **RebalancerBadge + RebalancerPanel** — rebalancer liveness status + diagnostics
- [x] **TVL on global page** — TVL-over-time chart + KPI tiles with 24h/7d/30d change %
- [x] **TVL Δ WoW column** on all pools table
- [x] **Protocol Revenue page** (`/revenue`) — swap fee time-series with 24h/7d/30d/all-time breakdowns
- [x] **Daily volume chart** alongside TVL chart on pool detail
- [x] **Error boundaries + loading skeletons** — route-level error handling
- [x] **Google Auth** (NextAuth.js) — restricted to `@mentolabs.xyz` accounts
- [x] **Chain icon prefix** — chain identifier on pool IDs in multichain view

### Infrastructure / DX

- [x] CI pipeline — ESLint 10 + Vitest (71 test files) + typecheck + Codecov
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

## Next — v3 Alerting

**Metrics pipeline is live end-to-end.** `metrics-bridge` (Cloud Run, `mento-monitoring` GCP project) polls Hasura every 30s and exports `mento_pool_*` gauges. Grafana Agent (aegis repo, App Engine in `mento-prod`) scrapes the bridge and remote-writes to Grafana Cloud (`clabsmento.grafana.net`). 11 FPMM pools across Celo + Monad mainnet are reporting with freshness around 25-30s.

Remaining work:

1. **Slack `#alerts-v3` channel + incoming webhook** — manual, then stash URL as `TF_VAR_slack_webhook_alerts_v3`. The channel covers `fpmms` / `oracles` / `cdps` / `metrics-bridge` alerts together.
2. **`terraform/alerts/` Terraform module** (this repo) — Grafana provider + contact point wired to the Slack webhook + notification policy routing `service =~ "fpmms|oracles|cdps|metrics-bridge"` → Slack + alert rules below.
3. **Smoke test** — briefly lower a threshold to confirm Slack fires.

### v3 KPIs to Alert On

Rules all attach a narrow `service` label (matches the existing Aegis convention of `service = monitored-domain` used in `aegis/terraform/grafana-alerts/alert-rules-*.tf`). Convention locked in: `fpmms`, `oracles`, `cdps`, `metrics-bridge` — see `SPEC.md §10`.

1. **Oracle liveness on pool** (`service=fpmms`) — warn when live-ratio `(time() - mento_pool_oracle_timestamp) / mento_pool_oracle_expiry` >0.8, critical on `mento_pool_oracle_ok == 0`
2. **Deviation breach** (`service=fpmms`) — warn when `mento_pool_deviation_ratio > 1` or `mento_pool_deviation_breach_start > 0`; critical when the breach persists >60min (`time() - mento_pool_deviation_breach_start > 3600`)
3. **Trading limit pressure** (`service=fpmms`) — warn on `max(mento_pool_limit_pressure) > 0.8`, critical on `>= 1`
4. **Rebalancer stale** (`service=fpmms`) — critical if deviation has been breaching >60min AND the rebalancer hasn't acted (`time() - mento_pool_last_rebalanced_at > 1800`)
5. **Bridge not reporting** (`service=metrics-bridge`) — critical if `time() - mento_pool_bridge_last_poll > 90` OR `rate(mento_pool_bridge_poll_errors_total[5m]) > 0`

### Deferred

- **Oracle report outliers** (`service=oracles`) — large deltas between consecutive reports. Needs indexer to track historical oracle prices; design still TBD
- **Stability Pool headroom** (`service=cdps`) — blocked on Liquity v2 CDP indexing

---

## Backlog

### Indexer Enhancements

- [ ] **Liquity v2 CDP indexing** — TroveManager, StabilityPool events
  - GBPm TroveManager: `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`
  - StabilityPool: `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
- [ ] **ChainStat / GlobalStat aggregate entities** — protocol-level metrics
- [ ] **Monad indexing** — config ready, contracts deployed

### Dashboard Backlog

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer

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
                ┌────────────┴─────────────┐
                │ Discord (Aegis v2)       │
                │ Splunk On-Call           │
                │ Slack #alerts-v3 (v3)    │
                └──────────────────────────┘
```

**Three data paths share a common Grafana Cloud + Grafana Agent stack:**

1. **Dashboard path**: Envio indexes on-chain events into Postgres → Hasura exposes GraphQL → Next.js dashboard renders
2. **v2 alerting (Aegis)**: Aegis polls contract state via RPC → exposes `/metrics` → Grafana Agent scrapes + remote-writes → alert rules → Discord + Splunk On-Call
3. **v3 alerting (metrics-bridge)**: Envio indexes FPMM pool KPIs → bridge polls Hasura every 30s → exports `mento_pool_*` gauges → Grafana Agent scrapes → Slack `#alerts-v3` (rules pending)

## Key Files

| What                 | Where                                          |
| -------------------- | ---------------------------------------------- |
| Indexer schema       | `indexer-envio/schema.graphql`                 |
| Event handlers       | `indexer-envio/src/EventHandlers.ts`           |
| Multichain config    | `indexer-envio/config.multichain.mainnet.yaml` |
| Mainnet config       | `indexer-envio/config.multichain.mainnet.yaml` |
| Dashboard app        | `ui-dashboard/src/app/`                        |
| Network defs         | `ui-dashboard/src/lib/networks.ts`             |
| GraphQL queries      | `ui-dashboard/src/lib/queries.ts`              |
| Pool type helper     | `ui-dashboard/src/lib/tokens.ts`               |
| FX calendar          | `shared-config/fx-calendar.json`               |
| Technical spec       | `SPEC.md`                                      |
| Deployment guide     | `docs/deployment.md`                           |
| Aegis config         | `../aegis/config.yaml`                         |
| Aegis alert rules    | `../aegis/terraform/grafana-alerts/`           |
| Aegis dashboards     | `../aegis/terraform/grafana-dashboard/`        |
| v3 metrics bridge    | `metrics-bridge/`                              |
| v3 agent scrape cfg  | `../aegis/grafana-agent/agent.yaml.tmpl`       |
| v3 alert rules (new) | `terraform/alerts/` (TBD)                      |
