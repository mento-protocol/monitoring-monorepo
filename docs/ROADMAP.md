# Monitoring Monorepo — Roadmap

Last updated: 2026-04-16

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

The `metrics-bridge` package polls Hasura for FPMM pool KPIs and exports them as Prometheus gauges (`mento_pool_*`). It runs on Cloud Run and gets scraped by Grafana Agent. The remaining work is defining Grafana alert rules in Terraform (Slack notifications).

### v3 KPIs to Alert On

1. **Oracle liveness** (FPMM pools) — warn when liveness ratio >0.8, critical when oracle expired (≥1.0)
2. **Deviation ratio** (FPMM pools) — warn as soon as `priceDifference > rebalanceThreshold` (breach entered); critical when the breach has lasted > 60min (`deviationBreachStartedAt` older than 1h)
3. **Trading limit pressure** (FPMM pools) — warn when max pressure >0.8, critical when limit hit (≥1.0)
4. **Rebalancer liveness** — critical if no rebalance within threshold window when needed
5. **Stability Pool headroom** — critical if headroom ≤ 0 (requires Liquity v2 indexing)

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
  │  monitoring.mento.org│     │  Alert Rules (TF)  │
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

1. **Dashboard path** (left): Envio indexes on-chain events into Postgres → Hasura exposes GraphQL → Next.js dashboard renders
2. **Alerting path** (right): Aegis polls contract state via RPC → exposes Prometheus metrics → Grafana Agent pushes to Grafana Cloud → alert rules evaluate → notifications fire

## Key Files

| What              | Where                                          |
| ----------------- | ---------------------------------------------- |
| Indexer schema    | `indexer-envio/schema.graphql`                 |
| Event handlers    | `indexer-envio/src/EventHandlers.ts`           |
| Multichain config | `indexer-envio/config.multichain.mainnet.yaml` |
| Mainnet config    | `indexer-envio/config.multichain.mainnet.yaml` |
| Dashboard app     | `ui-dashboard/src/app/`                        |
| Network defs      | `ui-dashboard/src/lib/networks.ts`             |
| GraphQL queries   | `ui-dashboard/src/lib/queries.ts`              |
| Pool type helper  | `ui-dashboard/src/lib/tokens.ts`               |
| FX calendar       | `shared-config/fx-calendar.json`               |
| Technical spec    | `SPEC.md`                                      |
| Deployment guide  | `docs/deployment.md`                           |
| Aegis config      | `../aegis/config.yaml`                         |
| Aegis alert rules | `../aegis/terraform/grafana-alerts/`           |
| Aegis dashboards  | `../aegis/terraform/grafana-dashboard/`        |
