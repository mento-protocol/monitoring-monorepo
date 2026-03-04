# Monitoring Monorepo — Roadmap

## ✅ Done

- [x] Envio indexer: DevNet + Celo-Sepolia (12 VirtualPools, 2 FPMMs)
- [x] Multi-chain dashboard with network switcher
- [x] Pool list, recent swaps, pool detail page
- [x] Reserve history chart (Plotly, interactive)
- [x] PoolSnapshots (hourly buckets, per-hour activity counters)
- [x] Token symbol mapping (all Sepolia stablecoins resolved from treb registry)
- [x] txHash on all indexed events
- [x] `@index` directives on schema for query performance
- [x] Monorepo extraction from devnet repo
- [x] Envio hosted migration plan (`docs/envio-hosted-migration.md`)

## 🔜 Next Up

### Deployment (needs account access)

- [ ] **Envio hosted deployment** — sign up at envio.dev, connect `monitoring-monorepo`, deploy Sepolia indexer. See `docs/envio-hosted-migration.md` for step-by-step.
- [ ] **Vercel deployment** — connect `ui-dashboard/`, set env vars:
  - `NEXT_PUBLIC_HASURA_URL_DEVNET` / `NEXT_PUBLIC_HASURA_URL_SEPOLIA`
  - `NEXT_PUBLIC_HASURA_SECRET_DEVNET` / `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA`
  - `NEXT_PUBLIC_EXPLORER_URL_DEVNET` / `NEXT_PUBLIC_EXPLORER_URL_SEPOLIA`
- [ ] **Google Auth** (NextAuth.js) — restrict to @mentolabs.xyz

### Dashboard Features (Phase 1)

- [ ] **Global page** — TVL across all pools, aggregate swap volume
- [ ] **Snapshot charts** — volume over time, cumulative volume (from PoolSnapshot entities)
- [ ] **Pool health KPIs** — swap count, notional volume, rebalance count (already in schema, need UI)
- [ ] **ChainStat / GlobalStat aggregates** — protocol-level metrics entity
- [ ] **Gap-fill for charts** — forward-fill missing hourly snapshots in the dashboard layer

### Indexer Enhancements (Phase 1)

- [ ] **Oracle state on Pool** — `oracleOk`, `livenessRatio`, `deviationRatio` fields
- [ ] **Trading limit tracking** — `limitPressure` field, warn/crit thresholds per spec
- [ ] **Rebalancer events** — liveness + effectiveness metrics
- [ ] **Pool cumulative fields in UI** — surface `swapCount`, `notionalVolume0/1`, `rebalanceCount`

### Phase 2

- [ ] **Liquity v2 indexing** — TroveManager, ActivePool, StabilityPool, CDPLiquidityStrategy
  - DevNet addresses known (see MEMORY.md), Sepolia TBD
- [ ] **Revenue tracking** — protocol fees, spread revenue per pool
- [ ] **Monad indexing** — blocked on contract deployment to Monad mainnet/testnet
- [ ] **Alerting (Aegis integration)** — Prometheus metrics → Grafana alerts for the 5 KPIs:
  1. Oracle liveness (warn >0.8, crit ≥1)
  2. Deviation ratio (warn ≥1 >15min, crit >60min)
  3. Trading limit pressure (warn >0.8, crit ≥1)
  4. Rebalance liveness + effectiveness
  5. Stability Pool headroom (crit ≤0)

### Phase 3

- [ ] **Roman's Streamlit sandbox** — Python/Streamlit app querying same Hasura backend
- [ ] **ClickHouse sink** — for heavy analytics beyond what Hasura/Postgres handles
- [ ] **Historical backfill** — when Envio adds `block.timestamp` to `onBlock` handlers

## Architecture

```
Envio HyperIndex (hosted) → Hasura GraphQL → Next.js Dashboard (Vercel)
                                            → Streamlit Sandbox (Phase 3)
                                            → Aegis Alerting (Phase 2)
```

## Key Files

| What | Where |
|------|-------|
| Indexer schema | `indexer-envio/schema.graphql` |
| Event handlers | `indexer-envio/src/EventHandlers.ts` |
| DevNet config | `indexer-envio/config.yaml` |
| Sepolia config | `indexer-envio/config.sepolia.yaml` |
| Dashboard app | `ui-dashboard/src/app/` |
| Network defs | `ui-dashboard/src/lib/networks.ts` |
| Token mapping | `ui-dashboard/src/lib/tokens.ts` |
| Migration plan | `docs/envio-hosted-migration.md` |
| Monitoring spec | See vault `projects/mento-v3-monitoring/SPEC.md` |
