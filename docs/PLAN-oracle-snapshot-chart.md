# Plan: OracleSnapshot Chart — Oracle Price History Timeline

**Feature:** Oracle price history chart on pool detail page (Analytics tab, FPMM pools only)

---

## Context

`OracleSnapshot` entities are already indexed (per-event: every `Swap`, `Rebalanced`, `UpdateReserves`).
`ORACLE_SNAPSHOTS` query already exists. The pool detail page has an Analytics tab.
What's missing: a visual chart showing oracle price + health status over time.

---

## Tasks

### 1. `OracleChart` component (`ui-dashboard/src/components/oracle-chart.tsx`)

Plotly dual-trace chart:

- **Primary y-axis:** Oracle price as a line trace, normalised to human-readable units (`oraclePrice / oraclePriceDenom`)
- **Secondary y-axis:** Price deviation as a percentage of threshold (`priceDifference / rebalanceThreshold * 100`), 0–100%+
- **Background colour bands** (using Plotly `layout.shapes`):
  - Green band: `deviation < 80%`
  - Yellow band: `80% ≤ deviation < 100%`
  - Red band: `deviation ≥ 100%`
- **Point colouring:** each data point coloured by `oracleOk` (red dot when oracle expired, green otherwise)
- **Hover tooltip:** timestamp, price, deviation%, numReporters, source
- **Dark theme** — matches existing `ReserveChart` / `SnapshotChart` styling

Props:

```ts
interface OracleChartProps {
  snapshots: OracleSnapshot[];
  token0Symbol: string;
  token1Symbol: string;
}
```

### 2. Query update (`ui-dashboard/src/lib/queries.ts`)

Update `ORACLE_SNAPSHOTS` to:

- Use `order_by: { timestamp: desc }` + `limit` (most recent N, reversed for chart display)
- Add `healthStatus` field if we add it to `OracleSnapshot` entity (see indexer task below)

Current query already fetches all needed fields — no schema change required for basic chart.

### 3. Wire into Analytics tab (`pool/[poolId]/page.tsx`)

- Add `OracleChart` above `SnapshotChart` in the Analytics tab, guarded by `isFpmm(pool)`
- VirtualPools: both charts hidden, empty state shown
- Reuse the same `ORACLE_SNAPSHOTS` query already fired in the Oracle tab — avoid double fetch by lifting query up or sharing SWR key

### 4. (Stretch) `healthStatus` on `OracleSnapshot` entity

Add `healthStatus: String!` to `OracleSnapshot` in `indexer-envio/schema.graphql` (computed from same roll-up logic as `Pool.healthStatus`). Allows colouring chart segments by health state without client-side recomputation.

Not required for initial chart — can be done as a follow-up indexer schema migration.

---

## Definition of Done

- [ ] `OracleChart` component renders with Plotly dual y-axis (price + deviation%)
- [ ] Background health bands visible (green / yellow / red)
- [ ] Points coloured by `oracleOk`
- [ ] Chart shows on Analytics tab for FPMM pools only
- [ ] VirtualPools see empty state, not a broken chart
- [ ] Dark theme, consistent with `ReserveChart` / `SnapshotChart`
- [ ] No double-fetch of `ORACLE_SNAPSHOTS` data
- [ ] Build ✅, lint ✅, all tests ✅

---

## End-to-End Testing Criteria

1. **Navigate to** `monitoring.mento.org/pool/0x8c0014...` (USDm/GBPm FPMM) → Analytics tab
2. **Chart renders** with price line and deviation% line visible
3. **WARN pool (GBPm/USDm):** deviation% line should be close to 100%, yellow/red band triggered
4. **OK pool (axlUSDC/USDm):** deviation% well below 80%, green band
5. **VirtualPool** (e.g. `/pool/<virtual-pool-id>`) → Analytics tab shows empty state
6. **Hover** over a point → tooltip shows all fields including `numReporters` and `source`
7. **Zoom/pan** works (Plotly native)

---

## Estimated Effort

~3h (no indexer changes needed for initial version)
