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

### Infrastructure / DX
- [x] Monorepo extraction from devnet repo
- [x] CI pipeline — ESLint 10 + Vitest + trunk on GitHub Actions (path-scoped)
- [x] 22 unit tests (token utils + oracle health logic)
- [x] `pnpm deploy:indexer:*` scripts
- [x] `pnpm update-endpoint:mainnet` — updates Vercel env var via API after redeploy
- [x] Post-deploy checklist printed by deploy script
- [x] `AGENTS.md` files for indexer + dashboard
- [x] Deployment docs (`docs/deployment.md`)

---

## 🔜 Next Up

### Immediate (quick wins)

- [ ] **Switch to health queries** — update `page.tsx` + `pool/[poolId]/page.tsx` to use
      `ALL_POOLS_WITH_HEALTH` / `POOL_DETAIL_WITH_HEALTH` so health badges show live data
      *(deferred pending stable endpoint — now unblocked)*
- [ ] **Google Auth** (NextAuth.js) — restrict dashboard to @mentolabs.xyz accounts
- [ ] **Update ROADMAP in repo** ← you're here

### Phase 1 — Dashboard Features

- [ ] **Global page** — TVL across all pools, aggregate swap volume, pool count by status
- [ ] **Snapshot charts** — volume over time, cumulative volume (PoolSnapshot entities already indexed)
- [ ] **Pool KPIs in UI** — surface `swapCount`, `notionalVolume0/1`, `rebalanceCount` on pool detail
- [ ] **OracleSnapshot chart** — oracle price history + health timeline on pool detail page
- [ ] **Gap-fill for charts** — forward-fill missing hourly snapshots in dashboard layer

### Phase 1 — Indexer Enhancements

- [ ] **Trading limit tracking** — `limitPressure` field, warn/crit thresholds per Roman's spec
- [ ] **Rebalancer events** — liveness + effectiveness metrics
- [ ] **ChainStat / GlobalStat aggregates** — protocol-level metrics entity

### Phase 2

- [ ] **Liquity v2 indexing** — TroveManager, ActivePool, StabilityPool, CDPLiquidityStrategy
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
# CI gate pattern active
