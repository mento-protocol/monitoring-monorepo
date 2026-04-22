# Monitoring Monorepo — Task Backlog

Last updated: 2026-04-16

## Next — v3 Alerting

The `metrics-bridge` package (Cloud Run) exports FPMM pool KPIs as Prometheus gauges. The remaining work is defining Grafana alert rules in Terraform (Slack notifications).

### v3 Alert Rules

- [ ] **Oracle liveness** — warn >0.8, crit ≥1 (oracle expired). FPMM pools only.
- [ ] **Deviation ratio** — warn on breach (`priceDifference > rebalanceThreshold`), crit when breach lasts >60min. Indexer tracks `deviationBreachStartedAt` as the grace-window anchor.
- [ ] **Trading limit pressure** — warn >0.8, crit ≥1.0 (limit hit). FPMM pools only.
- [ ] **Rebalancer liveness** — crit if no rebalance in threshold window when deviation is high
- [ ] **Stability Pool headroom** — crit ≤0 (undercollateralized). Blocked on Liquity v2 indexing.

### Infrastructure

- [ ] **Grafana Agent scrape target** — add metrics-bridge URL to Aegis agent config
- [ ] **Slack channel for v3 alerts** — create `#alerts-v3-pools` with webhook
- [ ] **Terraform alert rules** — add to `terraform/alerts/` in this monorepo

---

## Backlog — Indexer Enhancements

- [ ] **Liquity v2 CDP indexing**
  - TroveManager events: `TroveOpened`, `TroveClosed`, `TroveUpdated`, `LiquidationEvent`
  - StabilityPool events: `UserDepositChanged`, `PoolBalanceUpdated`
  - Contracts: TroveManager `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`, StabilityPool `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
  - New entities: `Trove`, `StabilityPoolSnapshot`
- [ ] **Monad indexing** — config ready, contracts deployed
- [ ] **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools, total swaps, global TVL)

## Backlog — Dashboard

- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer

## Backlog — Future

- [ ] **Streamlit sandbox** — Python/Streamlit reads same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Postgres

## Tech Debt

- [ ] Dashboard component test coverage (71 test files total, but many are lib/util — component tests sparse)
- [ ] Revenue page placeholders ("CDP Borrowing Fees" and "Reserve Yield" marked "Soon")

---

## Done

### Indexer

- [x] Envio indexer for Celo Sepolia (VirtualPools + FPMMs)
- [x] Envio indexer for Celo Mainnet (4 FPMMs: USDm/GBPm, USDm/axlUSDC, USDm/USDC, USDT/USDm)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] Oracle health state (`healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold`)
- [x] OracleSnapshot entity — per-event oracle price + health timeline
- [x] SortedOracles event indexing (mainnet only)
- [x] TradingLimit entity (`limitStatus`, `limitPressure0/1`, `netflow0/1`, `limit0/1`)
- [x] Rebalancer liveness (`rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio`)
- [x] PoolSnapshot pre-aggregation (volume, TVL, fees per pool per hour)
- [x] PoolDailySnapshot rollup (daily aggregation)
- [x] Pool cumulative fields (`swapCount`, `notionalVolume0/1`, `rebalanceCount`)
- [x] Deviation breach tracking (`deviationBreachStartedAt` on Pool)
- [x] FX weekend exclusion from healthscore math
- [x] FX calendar extracted to `shared-config` package
- [x] Multichain config (`config.multichain.mainnet.yaml` — Celo + Monad)
- [x] `txHash` on all events, `@index` directives for query performance
- [x] Multichain config: `config.multichain.mainnet.yaml`, `config.multichain.testnet.yaml`
- [x] Deploy branch strategy (`deploy/celo-mainnet`, `deploy/celo-sepolia`)
- [x] Token addresses sourced from `@mento-protocol/contracts`
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors

### Dashboard

- [x] Live at monitoring.mento.org
- [x] Global overview page (`/`) — metrics tiles, all pools table, activity ranking
- [x] Pool detail page (`/pools/[poolId]`) — trades, reserve chart, analytics tab
- [x] Oracle health: HealthBadge, HealthPanel, OracleChart (dual y-axis)
- [x] Analytics tab with PoolSnapshot charts
- [x] Fully multichain — network switcher dropped, chain icon prefix on pool IDs
- [x] Token symbol mapping, `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component
- [x] LimitBadge + LimitPanel (trading limit pressure per token)
- [x] RebalancerBadge + RebalancerPanel (liveness status + diagnostics)
- [x] TVL on global page — TVL-over-time chart + tiles with 24h/7d/30d change %
- [x] TVL Δ WoW column on all pools table
- [x] Protocol Revenue page (`/revenue`) — swap fee time-series
- [x] Daily volume chart on pool detail
- [x] Error boundaries + loading skeletons (route-level)
- [x] Google Auth (NextAuth.js — `@mentolabs.xyz` only)

### Infrastructure (Done)

- [x] Monorepo extraction from devnet repo
- [x] CI: ESLint 10 + Vitest (71 test files) + typecheck + Codecov
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — Vercel env var update after indexer redeploy
- [x] Discord notification on deploy branch push (`notify-envio-deploy.yml`)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

### Alerting (Aegis v2 — live)

- [x] Aegis NestJS service on GCP App Engine — polls v2 contract state via RPC
- [x] Grafana Agent on GCP → pushes Prometheus metrics to Grafana Cloud
- [x] Grafana dashboard: "Aegis — On-chain Metrics"
- [x] Alert rules: oracle relayers (stale feeds, low CELO balance)
- [x] Alert rules: reserve balances (low USDC/USDT/axlUSDC)
- [x] Alert rules: trading modes (circuit breakers tripped)
- [x] Alert rules: trading limits (L0/L1/LG utilization >90%)
- [x] Alert rules: Aegis service health (RPC failures, data staleness)
- [x] Contact points: 8 Discord webhooks + Splunk On-Call
- [x] Notification policies with severity-based routing
- [x] Weekend mute timings for FX rate feeds
- [x] All Grafana config Terraform-managed
