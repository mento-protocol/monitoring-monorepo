# Monitoring Monorepo — Roadmap

Last updated: 2026-03-05

## ✅ Done

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
- [x] **PoolSnapshot pre-aggregation** — volume, TVL, fees per pool per day (industry-standard pattern)
- [x] Pool cumulative fields: `swapCount`, `notionalVolume0/1`, `rebalanceCount`
- [x] `txHash` on all indexed events
- [x] `@index` directives on schema for query performance
- [x] Deploy branch strategy (`deploy/celo-sepolia`, `deploy/celo-mainnet`)
- [x] Config files named `config.celo.{network}.yaml`

### Dashboard

- [x] **Live at [monitoring.mento.org](https://monitoring.mento.org)**
- [x] **Global overview page** (`/`) — protocol-wide metrics tiles, all pools table, activity ranking
- [x] **Pool detail page** (`/pools/[poolId]`) — trades table, reserve history chart, analytics tab
- [x] **Analytics tab** — PoolSnapshot charts (hourly swap volume + cumulative count)
- [x] **Oracle health state** — HealthBadge, HealthPanel on pool detail
- [x] **Oracle chart** on analytics tab (FPMM pools only — dual y-axis price + deviation%)
- [x] Pool list with health badge column (🟢 OK / 🟡 WARN / 🔴 CRITICAL / ⚪ N/A)
- [x] Multi-chain network switcher (Mainnet / Sepolia / local)
- [x] Token symbol mapping via `isFpmm()` in `tokens.ts`
- [x] `contracts.json` integrated into `networks.ts`
- [x] Shared `PoolsTable` component (reused across home + pools pages)

### Infrastructure / DX

- [x] CI pipeline — ESLint 10 + Vitest (53 tests) + typecheck + Codecov
- [x] `pnpm deploy:indexer:*` scripts
- [x] `pnpm update-endpoint:mainnet` — updates Vercel env var via API after indexer redeploy
- [x] **Discord notification on deploy branch push** (`notify-envio-deploy.yml`)
- [x] `AGENTS.md` files for indexer + dashboard
- [x] Deployment docs (`docs/deployment.md`)

---

## 🔜 Stream C — Dashboard KPI Components

These are the next immediate items. Indexer schema already supports them — dashboard components are pending.

- [ ] **LimitBadge + LimitPanel** — surface `limitStatus` / `limitPressure0/1` from TradingLimit entity
- [ ] **LivenessBadge + RebalancerPanel** — surface `rebalanceLivenessStatus` + rebalance event timeline
- [ ] **TVL on global page** — sum of reserves across pools (price conversion or raw display)
- [ ] **Gap-fill for charts** — forward-fill missing hourly snapshots in dashboard layer

---

## 🔜 Phase 2 — Indexer Enhancements

- [ ] **Liquity v2 CDP indexing** — TroveManager, StabilityPool events
  - GBPm TroveManager: `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9`
  - StabilityPool: `0x06346c0fAB682dBde9f245D2D84677592E8aaa15`
- [ ] **ChainStat / GlobalStat aggregate entities** — protocol-level metrics
- [ ] **Monad indexing** — blocked on contract deployment to Monad

---

## 🔜 Phase 2 — Alerting (Aegis)

- [ ] Prometheus metrics export from indexer
- [ ] Grafana dashboards for ops team
- [ ] Alert thresholds (from spec):
  1. Oracle liveness (warn >0.8, crit ≥1)
  2. Deviation ratio (warn ≥0.8 sustained >15min, crit >60min)
  3. Trading limit pressure (warn >0.8, crit ≥1)
  4. Rebalancer liveness + effectiveness
  5. Stability Pool headroom (crit ≤0)
- [ ] Discord / PagerDuty alert channels

---

## 🔜 Phase 3

- [ ] **Roman's Streamlit sandbox** — Python/Streamlit app on same Hasura backend
- [ ] **Google Auth** (NextAuth.js) — restrict dashboard to @mentolabs.xyz accounts
- [ ] **ClickHouse sink** — heavy analytics beyond Hasura/Postgres

---

## Architecture

```text
Envio HyperIndex (hosted) → Hasura GraphQL → Next.js Dashboard (Vercel)
                                            → Streamlit Sandbox (Phase 3)
                                            → Aegis/Grafana Alerting (Phase 2)
```

## Key Files

| What             | Where                                        |
| ---------------- | -------------------------------------------- |
| Indexer schema   | `indexer-envio/schema.graphql`               |
| Event handlers   | `indexer-envio/src/EventHandlers.ts`         |
| Mainnet config   | `indexer-envio/config.celo.mainnet.yaml`     |
| Sepolia config   | `indexer-envio/config.celo.sepolia.yaml`     |
| Dashboard app    | `ui-dashboard/src/app/`                      |
| Network defs     | `ui-dashboard/src/lib/networks.ts`           |
| GraphQL queries  | `ui-dashboard/src/lib/queries.ts`            |
| Pool type helper | `ui-dashboard/src/lib/tokens.ts`             |
| Technical spec   | `SPEC.md`                                    |
| Deployment guide | `docs/deployment.md`                         |
