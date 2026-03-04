# Monitoring Monorepo — Task Backlog

Last updated: 2026-03-04

## 🔴 Blockers / Next Up

### ~~Envio Hosted Deployment~~ ✅

Deployed at [envio.dev/app/mento-protocol/mento-v3-celo-sepolia](https://envio.dev/app/mento-protocol/mento-v3-celo-sepolia)

### ~~Vercel Deployment~~ ✅

Live at [monitoring-ui-dashboard.vercel.app](https://monitoring-ui-dashboard.vercel.app)

- [x] Vercel project created (`chapatis-projects/monitoring-ui-dashboard`)
- [x] Env vars set (`NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED`)
- [x] Build verified — Next.js 16 + pnpm monorepo deploys cleanly
- [ ] Share URL with team
- [ ] Add GitHub secrets for auto-deploy CI (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`)

## 🟡 Dashboard Features (Phase 1)

### Global Page

- [ ] TVL across all pools (sum of reserves in USD equivalent)
- [ ] Total swap volume (cumulative)
- [ ] Pool count by type (FPMM vs VirtualPool)
- [ ] Chain-level stats (ChainStat entity)

### Snapshot-Based Charts

- [ ] Volume over time (hourly/daily bars from PoolSnapshot)
- [ ] Cumulative volume line chart
- [ ] TVL over time
- [ ] Gap-filling via forward-fill in dashboard (Envio block handlers lack timestamp)

### Pool Health KPIs

- [ ] Oracle liveness indicator (oracleOk, livenessRatio fields on Pool)
- [ ] Deviation ratio warnings (warn ≥1 for >15min, crit >60min)
- [ ] Trading limit pressure (warn >0.8, crit ≥1.0)
- [ ] Rebalance liveness + effectiveness

### Pool Detail Enhancements

- [ ] Liquidity depth visualization
- [ ] Rebalance event timeline
- [ ] Fee revenue per pool

## 🟢 Infrastructure

### Indexer Improvements

- [ ] Oracle state fields on Pool entity (oracleOk, livenessRatio)
- [ ] ChainStat / GlobalStat aggregate entities
- [ ] Liquity v2 indexing (TroveManager, StabilityPool, CDPs)
  - Contracts on DevNet: TroveManager `0xF1fE...`, ActivePool `0x9B41...`, etc.
  - Separate ABI + handler needed
- [ ] Monad indexing (blocked on contract deployment)

### Alerting (Phase 2)

- [ ] Aegis integration for real-time state-based alerting
- [ ] Prometheus metrics export from indexer
- [ ] Grafana dashboards for ops team
- [ ] Discord/Telegram alert channels

### DevEx

- [ ] Google Auth (NextAuth.js) for dashboard access control
- [ ] Streamlit sandbox for Roman (Python, reads from same Hasura)

## 📋 Tech Debt

- [ ] Dashboard has no test coverage
- [ ] Hasura admin secret exposed in client bundle (needs server-side proxy for prod)
- [ ] `setURL` in page.tsx doesn't preserve all query params when switching filters
- [ ] DevNet address book is hardcoded (2 tokens) — was dynamic in devnet repo
- [ ] No error boundaries or loading skeletons in dashboard
- [ ] Port 9898 hardcoded in Envio — can't run multiple indexers simultaneously

## ✅ Done

- [x] Envio indexer for Celo DevNet (2 pools, 40 events)
- [x] Envio indexer for Celo Sepolia (12 VirtualPools, 12 events)
- [x] Next.js dashboard with multi-chain network switching
- [x] Reserve history chart (Plotly)
- [x] PoolSnapshots with hourly buckets
- [x] Sepolia token symbol mapping (14 stablecoins + PUSO)
- [x] Monorepo extraction from devnet repo
- [x] Vercel config (`vercel.json`)
- [x] Browser-verified end-to-end (DevNet + Sepolia + reserves chart)
- [x] Envio hosted migration plan researched
- [x] Config files renamed to `config.celo.{network}.yaml`
- [x] Deploy branch strategy (`deploy/celo-sepolia`, `deploy/celo-mainnet`, `deploy/monad-mainnet`)
- [x] pnpm deploy scripts (`deploy:indexer:sepolia/mainnet/monad`)
- [x] Network config expanded with `local`/`hosted` variants per chain
- [x] `contracts.json` committed to repo + integrated into network config for token/address resolution
- [x] CI pipeline (lint, typecheck, build) on GitHub Actions — `indexer-envio.yml` + `ui-dashboard.yml`
- [x] Code quality toolchain (ESLint 10 + vitest + trunk)
- [x] `AGENTS.md` with Envio gotchas (Hasura port 8080, single-indexer constraint, postgres healthcheck patch)
- [x] Envio hosted deployment — `mento-v3-celo-sepolia` live at [envio.dev](https://envio.dev/app/mento-protocol/mento-v3-celo-sepolia)
