# Monitoring Monorepo — Task Backlog

Last updated: 2026-03-05

## 🔴 Immediate — Stream C Dashboard KPI Components

Indexer schema is complete. These are dashboard-only items.

- [ ] **LimitBadge** — show `limitStatus` (OK/WARN/CRITICAL) on pool list + detail
- [ ] **LimitPanel** — breakdown of `limitPressure0/1` and `netflow0/1` per token on pool detail
- [ ] **LivenessBadge** — show `rebalanceLivenessStatus` (ACTIVE / N/A) on pool list
- [ ] **RebalancerPanel** — rebalance event timeline + `effectivenessRatio` on pool detail
- [ ] **TVL on global page** — sum `reserves0/1` across pools (decide: raw amounts vs USD)
- [ ] **Gap-fill for snapshot charts** — forward-fill missing hourly buckets in dashboard layer (not block handlers — Envio `onBlock` lacks timestamp)

## 🟡 Phase 2 — Indexer + Alerting

### Indexer Enhancements

- [ ] **Liquity v2 CDP indexing**
  - TroveManager events: `TroveOpened`, `TroveClosed`, `TroveUpdated`, `LiquidationEvent`
  - StabilityPool events: `UserDepositChanged`, `PoolBalanceUpdated`
  - Contracts: TroveManager `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`, StabilityPool `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
  - New entities: `Trove`, `StabilityPoolSnapshot`
- [ ] **Monad indexing** — blocked on contract deployment to Monad
- [ ] **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools, total swaps, global TVL)

### Alerting (Aegis/Grafana)

- [ ] Prometheus metrics export from indexer
- [ ] Grafana dashboards
- [ ] Alert rule: oracle liveness (warn >0.8, crit ≥1)
- [ ] Alert rule: deviation ratio (warn ≥0.8 for >15min, crit >60min)
- [ ] Alert rule: trading limit pressure (warn >0.8, crit ≥1.0)
- [ ] Alert rule: rebalancer liveness (crit if no rebalance in threshold window)
- [ ] Alert rule: Stability Pool headroom (crit ≤0)
- [ ] Discord/PagerDuty channels

## 🟢 Phase 3

- [ ] **Roman's Streamlit sandbox** — Python/Streamlit reads same Hasura backend
- [ ] **Google Auth** (NextAuth.js) — restrict dashboard to @mentolabs.xyz
- [ ] **ClickHouse sink** — heavy analytics beyond Postgres

## 📋 Tech Debt

- [ ] Dashboard test coverage (currently 53 tests, all in lib utils — zero component tests)
- [ ] Hasura admin secret exposed in client bundle — needs server-side proxy or Hasura JWT auth for prod
- [ ] `setURL` in page.tsx doesn't preserve all query params on filter switch
- [ ] No error boundaries or loading skeletons in dashboard UI
- [ ] Port 9898 hardcoded in Envio — can't run multiple indexers simultaneously
- [ ] DevNet config (`config.celo.devnet.yaml`) may be stale — devnet is no longer primary target

## ✅ Done

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
- [x] PoolSnapshot pre-aggregation (volume, TVL, fees per pool per hour/day)
- [x] Pool cumulative fields (`swapCount`, `notionalVolume0/1`, `rebalanceCount`)
- [x] `txHash` on all events
- [x] `@index` directives for query performance
- [x] Config files: `config.celo.mainnet.yaml`, `config.celo.sepolia.yaml`
- [x] Deploy branch strategy (`deploy/celo-mainnet`, `deploy/celo-sepolia`)
- [x] `contracts.json` committed + integrated into network config

### Dashboard

- [x] Live at monitoring.mento.org
- [x] Global overview page (`/`) — metrics tiles, all pools table, activity ranking
- [x] Pool detail page (`/pools/[poolId]`) — trades, reserve chart, analytics tab
- [x] Oracle health: HealthBadge, HealthPanel, OracleChart (dual y-axis)
- [x] Analytics tab with PoolSnapshot charts
- [x] Multi-chain network switcher
- [x] Token symbol mapping, `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component

### Infrastructure

- [x] Monorepo extraction from devnet repo
- [x] CI: ESLint 10 + Vitest (53 tests) + typecheck + Codecov
- [x] `pnpm deploy:indexer:*` scripts
- [x] `pnpm update-endpoint:mainnet` — Vercel env var update after indexer redeploy
- [x] Discord notification on deploy branch push (`notify-envio-deploy.yml`) — PR #17
- [x] `AGENTS.md` files for indexer + dashboard
- [x] Deployment docs (`docs/deployment.md`)
