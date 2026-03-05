# Monitoring Monorepo — Roadmap

## ✅ Done

### Indexer
- [x] Envio indexer: DevNet + Celo-Sepolia configs (12 VirtualPools, 2 FPMMs)
- [x] Envio indexer: Celo Mainnet config (4 FPMMs + 12 VirtualPools)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced, ~49k events
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] PoolSnapshots (hourly buckets, per-hour activity counters)
- [x] txHash on all indexed events
- [x] `@index` directives on schema for query performance
- [x] Pool cumulative fields: `swapCount`, `notionalVolume0/1`, `rebalanceCount`
- [x] **Oracle health state** — `healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold` on FPMM pools
- [x] **OracleSnapshot entity** — per-event oracle price + health timeline
- [x] SortedOracles events indexed (mainnet only — Sepolia/DevNet return zero address)
- [x] Config files named `config.celo.{network}.yaml`
- [x] Deploy branch strategy (`deploy/celo-sepolia`, `deploy/celo-mainnet`, `deploy/monad-mainnet`)

### Dashboard
- [x] Multi-chain dashboard with network switcher (DevNet / Sepolia / Mainnet)
- [x] Pool list with health badge column (🟢 OK / 🟡 WARN / 🔴 CRITICAL)
- [x] Pool detail page with reserve history chart (Plotly, interactive)
- [x] Recent swaps table with txHash links
- [x] Token symbol mapping (on-chain `symbol()` values, not registry names)
- [x] `contracts.json` integrated into `networks.ts`
- [x] **Dashboard LIVE at monitoring.mento.org**
- [x] **Global overview page** (`/`) — summary tiles, health breakdown, all pools table, activity ranking
- [x] **Pool list moved to `/pools`** — Global is now the homepage
- [x] **Analytics tab** on pool detail — snapshot charts (hourly swap volume + cumulative count)
- [x] **Shared `PoolsTable` component** — reused across home + global pages
- [x] **`isFpmm()` utility** in `tokens.ts` — single source of truth for pool type detection

### Infrastructure / DX
- [x] Monorepo extraction from devnet repo
- [x] CI pipeline — ESLint 10 + Vitest + trunk on GitHub Actions
- [x] CI path filters removed from `pull_request` triggers — both workflows always report status
- [x] 22 unit tests (token utils + oracle health logic)
- [x] `pnpm deploy:indexer:*` scripts
- [x] `pnpm update-endpoint:mainnet` — updates Vercel env var via API after redeploy
- [x] Post-deploy checklist printed by deploy script
- [x] **Discord notification on deploy branch push** — `notify-envio-deploy.yml` fires on `deploy/*` branches, posts reminder to update Vercel endpoint
- [x] `AGENTS.md` files for indexer + dashboard
- [x] Deployment docs (`docs/deployment.md`)

---

## 🔜 Next Up

### Immediate (quick wins)

- [ ] **Google Auth** (NextAuth.js) — restrict dashboard to @mentolabs.xyz accounts
- [ ] **OracleSnapshot chart improvements** — oracle price history timeline on pool detail
- [ ] **Merge PRs #2 and #4** — config rename + deploy branch docs (still open, no conflicts)

### Phase 1 — Dashboard Features

- [ ] **Trading limit tracking** — `limitPressure` field on Pool, warn/crit thresholds per Roman's spec
- [ ] **Rebalancer liveness/effectiveness metrics** — surface rebalance events + lag tracking
- [ ] **TVL on global page** — requires price conversion or raw reserve amounts display
- [ ] **Gap-fill for charts** — forward-fill missing hourly snapshots in dashboard layer

### Phase 1 — Indexer Enhancements

- [ ] **Trading limit events** — index `TradingLimitUpdated` + `BreakerBox` state changes
- [ ] **Rebalancer events** — track liveness + effectiveness (time since last rebalance per pool)
- [ ] **ChainStat / GlobalStat aggregates** — protocol-level metrics entity

### Phase 2

- [ ] **Liquity v2 indexing** — TroveManager, ActivePool, StabilityPool, CDPLiquidityStrategy
  - GBPm TroveManager: `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`
  - StabilityPool: `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
- [ ] **Revenue tracking** — protocol fees, spread revenue per pool
- [ ] **Monad indexing** — blocked on contract deployment to Monad
- [ ] **Alerting (Aegis)** — Prometheus metrics → Grafana alerts for 5 KPIs:
  1. Oracle liveness (warn >0.8, crit ≥1)
  2. Deviation ratio (warn ≥0.8 sustained, crit >60min)
  3. Trading limit pressure (warn >0.8, crit ≥1)
  4. Rebalance liveness + effectiveness
  5. Stability Pool headroom (crit ≤0)

### Phase 3

- [ ] **Roman's Streamlit sandbox** — Python/Streamlit app on same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Hasura/Postgres
- [ ] **Historical backfill** — when Envio adds `block.timestamp` to `onBlock` handlers

---

## Architecture

```text
Envio HyperIndex (hosted) → Hasura GraphQL → Next.js Dashboard (Vercel)
                                            → Streamlit Sandbox (Phase 3)
                                            → Aegis Alerting (Phase 2)
```

## Key Files

| What | Where |
|------|-------|
| Indexer schema | `indexer-envio/schema.graphql` |
| Event handlers | `indexer-envio/src/EventHandlers.ts` |
| Mainnet config | `indexer-envio/config.celo.mainnet.yaml` |
| Sepolia config | `indexer-envio/config.celo.sepolia.yaml` |
| DevNet config | `indexer-envio/config.celo.devnet.yaml` |
| Dashboard app | `ui-dashboard/src/app/` |
| Network defs | `ui-dashboard/src/lib/networks.ts` |
| GraphQL queries | `ui-dashboard/src/lib/queries.ts` |
| Deployment guide | `docs/deployment.md` |
| Monitoring spec | vault `projects/mento-v3-monitoring/SPEC.md` |
