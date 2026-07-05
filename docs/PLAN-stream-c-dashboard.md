---
title: "Stream C: Dashboard Components for Trading Limits & Rebalancer Liveness"
status: archived
owner: eng
canonical: false
archived: 2026-07-05
archived_reason: "Trading-limit and rebalancer-liveness dashboard components shipped (LimitBadge/LimitPanel, RebalancerBadge/RebalancerPanel). The 'Status: Planned' line below is stale. See docs/ROADMAP.md → Dashboard."
---

> **ARCHIVED** — This planning document is superseded by shipped work; the "Status: Planned" line below is historical. See [`docs/ROADMAP.md`](./ROADMAP.md) for current state.

# Stream C: Dashboard Components for Trading Limits & Rebalancer Liveness

**Date:** 2026-03-05  
**Status:** Planned  
**Branch:** `feat/stream-c-limits-rebalancer-dashboard`

---

## Context

The indexer (PR #21, merged) already indexes:

- `Pool.limitStatus` — "OK" | "WARN" | "CRITICAL" | "N/A"
- `Pool.limitPressure0` / `limitPressure1` — string floats e.g. "0.1230" (worst pressure of the two tokens)
- `Pool.rebalancerAddress` — address string
- `Pool.rebalanceLivenessStatus` — "ACTIVE" | "N/A" (STALE computed client-side)
- `Pool.lastRebalancedAt` — epoch seconds BigInt
- `TradingLimit` entity — per-pool/per-token limit details (limit0/1, netflow0/1, decimals, limitPressure0/1, limitStatus)
- `RebalanceEvent.rebalancerAddress`, `.improvement`, `.effectivenessRatio`

This stream adds the dashboard components to surface that data.

---

## Scope

### New components

1. **`LimitBadge`** — inline status badge (OK/WARN/CRITICAL/N/A) for trading limit pressure
2. **`LimitPanel`** — pool detail section showing per-token limit bars + current netflow/limit values
3. **`RebalancerPanel`** — pool detail section showing rebalancer address, liveness status, effectiveness history

### Updates to existing components

4. **`PoolsTable`** — add `Limit` and `Rebalancer` columns (FPMM only; N/A for VirtualPools)
5. **`pool/[poolId]/page.tsx`** — add LimitPanel + RebalancerPanel to Overview tab
6. **`queries.ts`** — add `TRADING_LIMITS` query + extend `ALL_POOLS_WITH_HEALTH` and `POOL_DETAIL_WITH_HEALTH` with new fields
7. **`types.ts`** — add `TradingLimit` type + extend `Pool` type with new fields
8. **`health.ts`** — add `computeLimitStatus()` helper (client-side STALE detection for rebalancer)
9. **`tokens.ts`** — confirm `isFpmm()` covers limit/rebalancer gating (already there, just verify)

### Out of scope

- New indexer changes (indexer is already deployed)
- Liquity v2 views
- Alerting

---

## Definition of Done

- [ ] `LimitBadge` renders OK/WARN/CRITICAL/N/A with correct colors
- [ ] `LimitPanel` shows per-token limit bars (token0 and token1) with pressure %, current netflow, and limit values for FPMM pools; shows "N/A — VirtualPool" for non-FPMM
- [ ] `RebalancerPanel` shows rebalancer address (truncated + Celoscan link), liveness badge (ACTIVE/STALE/N/A), last rebalanced time, and effectiveness column in rebalance history table for FPMM pools
- [ ] `PoolsTable` shows `Limit` and `Rebalancer` badge columns; both N/A for VirtualPools
- [ ] Pool detail page Overview tab includes `LimitPanel` and `RebalancerPanel`
- [ ] Queries include all new fields (limitStatus, limitPressure0/1, rebalancerAddress, rebalanceLivenessStatus, TradingLimit entity)
- [ ] All existing 53 tests still pass
- [ ] ≥ 10 new tests covering: `computeLimitStatus()`, `LimitBadge` rendering, `computeRebalancerLiveness()`, pressure bar edge cases (0%, 80%, 100%, >100%)
- [ ] TypeScript strict — no `any`, no type errors
- [ ] Lint clean
- [ ] PR opens to `main`, Vercel preview builds successfully

---

## Testing Criteria

### Unit tests (vitest)

```
computeLimitStatus()
  ✓ returns "OK" when pressure < 0.8
  ✓ returns "WARN" when pressure >= 0.8 and < 1.0
  ✓ returns "CRITICAL" when pressure >= 1.0
  ✓ returns "N/A" for VirtualPools

computeRebalancerLiveness()
  ✓ returns "N/A" for VirtualPools
  ✓ returns "ACTIVE" if lastRebalancedAt within 24h OR healthStatus OK
  ✓ returns "STALE" if lastRebalancedAt > 86400s ago AND healthStatus != OK

LimitBadge
  ✓ renders green dot + "OK" for OK status
  ✓ renders yellow dot + "WARN" for WARN status
  ✓ renders red dot + "CRITICAL" for CRITICAL status
  ✓ renders grey dot + "N/A" for N/A status

LimitPressureBar (pressure value formatting)
  ✓ 0% pressure → green bar, "0%" label
  ✓ 50% pressure → green bar
  ✓ 80% pressure → amber bar
  ✓ 100% pressure → red bar, "100%" label
  ✓ >100% pressure → red bar, capped at 100% width, shows actual % in label
```

### Manual / integration checks

- On mainnet Celo, open a known FPMM pool (e.g. USDm/USDC `0x462f...`)
  - LimitPanel shows two token rows with pressure bars
  - LimitBadge in PoolsTable matches the panel status
  - RebalancerPanel shows a non-empty address
- Open a VirtualPool — all limit/rebalancer fields show N/A
- Verify no console errors on pool detail page

---

## Implementation Notes

### Client-side STALE computation

The indexer sets `rebalanceLivenessStatus = "ACTIVE"` on each rebalance event.  
Dashboard computes STALE as:

```ts
function computeRebalancerLiveness(pool: Pool, now: number): RebalancerStatus {
  if (!isFpmm(network, pool.token0, pool.token1)) return "N/A";
  if (!pool.lastRebalancedAt || pool.lastRebalancedAt === "0") return "N/A";
  const age = now - Number(pool.lastRebalancedAt);
  const isStale = age > 86400 && pool.healthStatus !== "OK";
  return isStale ? "STALE" : "ACTIVE";
}
```

### Worst-of pressure for table column

`PoolsTable` shows a single `LimitBadge` per pool using `pool.limitStatus` (already computed by indexer as worst-of across both tokens). No re-computation needed.

### TradingLimit query

The `TradingLimit` entity is keyed `{poolId}-{tokenAddress}`. Pool detail page fetches it separately:

```graphql
query TradingLimits($poolId: String!) {
  TradingLimit(where: { poolId: { _eq: $poolId } }) {
    id
    token
    limit0
    limit1
    decimals
    netflow0
    netflow1
    limitPressure0
    limitPressure1
    limitStatus
    updatedAtTimestamp
  }
}
```

### Rebalance history effectiveness

`RebalanceEvent` already has `effectivenessRatio` and `improvement` fields from the indexer. Add these columns to the existing rebalance history table on the pool detail page.

---

## File Checklist

```
ui-dashboard/src/
├── components/
│   ├── badges.tsx              ← add LimitBadge, RebalancerBadge
│   ├── limit-panel.tsx         ← new
│   └── rebalancer-panel.tsx    ← new
├── lib/
│   ├── types.ts                ← add TradingLimit type, extend Pool
│   ├── queries.ts              ← add TRADING_LIMITS, extend existing queries
│   └── health.ts               ← add computeLimitStatus(), computeRebalancerLiveness()
├── app/
│   └── pool/[poolId]/page.tsx  ← add LimitPanel + RebalancerPanel to Overview tab
└── lib/__tests__/
    └── health.test.ts          ← extend with limit + rebalancer tests
```
