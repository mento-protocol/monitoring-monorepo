# Plan: Rebalancer Liveness & Effectiveness

**Feature:** Track whether rebalancers are active and whether rebalances are actually improving oracle health

---

## Context

`RebalanceEvent` entities are already indexed with:
- `poolId`, `sender`, `priceDifferenceBefore`, `priceDifferenceAfter`, `txHash`, `blockTimestamp`

`Pool.lastRebalancedAt` (BigInt timestamp) and `Pool.rebalanceCount` already tracked.

**What we need to add:**
1. **Liveness:** Time since last rebalance — is any rebalancer bot actually running?
2. **Effectiveness:** Is each rebalance actually reducing `priceDifference`?
3. **Dashboard surface:** Liveness badge per pool + rebalance history table

**Roman's spec KPI #4:** Rebalance liveness + effectiveness. No explicit threshold defined — we'll use sensible defaults (WARN if >24h since last rebalance on a WARN/CRITICAL pool).

---

## Tasks

### Indexer

#### 1. Add `rebalanceEffectiveness` to `RebalanceEvent`

Already has `priceDifferenceBefore` and `priceDifferenceAfter`. Add computed field:

```graphql
type RebalanceEvent {
  # ... existing fields ...
  improvement: Int!  # priceDifferenceBefore - priceDifferenceAfter (positive = good)
  effectivenessRatio: String!  # improvement / priceDifferenceBefore (0–1)
}
```

Computed in handler at index time — no RPC needed, both values are in the event.

#### 2. Add liveness fields to `Pool`

```graphql
# In Pool type — already has lastRebalancedAt
rebalancerAddress: String!  # address of last rebalance sender
timeSinceRebalance: BigInt! # block.timestamp - lastRebalancedAt (seconds)
rebalanceLivenessStatus: String!  # "ACTIVE" | "STALE" | "N/A"
```

Update on every `Rebalanced` event handler.

`rebalanceLivenessStatus` logic:
- `N/A` if pool has never been rebalanced (`rebalanceCount == 0`) or is VirtualPool
- `ACTIVE` if `block.timestamp - lastRebalancedAt < 86400` (< 24h)
- `STALE` if ≥ 24h — but **only flag as STALE if `healthStatus` is WARN or CRITICAL** (a pool that's healthy doesn't need rebalancing)

**Note:** `timeSinceRebalance` is stale once indexed — it's the delta at index time, not live. The dashboard should compute live delta from `Pool.lastRebalancedAt` and `now` client-side. The indexed field is useful for historical queries.

#### 3. Add `RebalancerStat` entity (optional stretch)

Per-rebalancer-address aggregated stats:
```graphql
type RebalancerStat {
  id: ID!                     # sender address
  address: String!
  totalRebalances: Int!
  avgEffectivenessRatio: String!
  lastActiveAt: BigInt!
  lastActivePool: String!
}
```

Useful for the Ops screen in Roman's spec ("who is rebalancing?"). Can be Phase 2.

---

### Dashboard

#### 4. Add fields to `POOL_DETAIL_WITH_HEALTH` and `ALL_POOLS_WITH_HEALTH` queries

Fetch `lastRebalancedAt`, `rebalanceCount`, `rebalancerAddress`, `rebalanceLivenessStatus`.

#### 5. `LivenessBadge` component

```
ACTIVE → 🟢  "Rebalanced Xh ago"
STALE  → 🟡  "No rebalance in 24h+"
N/A    → ⚪  (never rebalanced or VirtualPool)
```

Compute live time delta client-side from `pool.lastRebalancedAt` — don't rely on indexed `timeSinceRebalance`.

#### 6. Pool detail: `RebalancerPanel` in Overview tab

Show alongside `HealthPanel` and `LimitPanel`:
- Last rebalancer address (truncated, linked to Celoscan)
- Time since last rebalance (live, computed client-side)
- Total rebalance count
- `LivenessBadge`

#### 7. Pool detail: Rebalances tab — add effectiveness column

Current Rebalances tab shows the event table. Add:
- `Improvement` column: `priceDifferenceBefore → priceDifferenceAfter` with delta
- `Effectiveness` column: percentage reduction in price difference
- Sort by most recent by default

**Query:** Add `improvement` and `effectivenessRatio` to `POOL_REBALANCES` query (once indexer fields added).

#### 8. Global page: rebalancer liveness summary

Add a `Rebalancer` section to the global overview page:
- Count of FPMM pools with `ACTIVE` / `STALE` / `N/A` liveness
- List of any `STALE` pools with health `WARN`/`CRITICAL` (action required)

#### 9. Unit tests

```
computeLivenessStatus(healthStatus="WARN",  lastRebalancedAt=now-1h)  → "ACTIVE"
computeLivenessStatus(healthStatus="WARN",  lastRebalancedAt=now-25h) → "STALE"
computeLivenessStatus(healthStatus="OK",    lastRebalancedAt=now-25h) → "ACTIVE"  # healthy pools don't need it
computeLivenessStatus(healthStatus="OK",    rebalanceCount=0)         → "N/A"
effectivenessRatio(before=8000, after=4000) → "0.500"
effectivenessRatio(before=8000, after=9000) → "-0.125"  # rebalance made it worse (shouldn't happen but handle it)
```

---

## Definition of Done

- [ ] `improvement` + `effectivenessRatio` fields on `RebalanceEvent`
- [ ] `rebalancerAddress` + `rebalanceLivenessStatus` on `Pool`
- [ ] `LivenessBadge` component (ACTIVE / STALE / N/A)
- [ ] Liveness info in pool detail Overview tab (`RebalancerPanel`)
- [ ] Effectiveness columns in pool detail Rebalances tab
- [ ] Rebalancer liveness summary section on global page
- [ ] Unit tests for `computeLivenessStatus` + `effectivenessRatio` (6 cases)
- [ ] New indexer deployed + Vercel endpoint updated
- [ ] Build ✅, lint ✅, all tests ✅

---

## End-to-End Testing Criteria

1. **Pool list (global page)** → rebalancer summary section shows count of ACTIVE/STALE pools
2. **FPMM pool detail → Overview:** `RebalancerPanel` shows last rebalancer address + time since rebalance
3. **GBPm/USDm pool** (most active, WARN status): should show `ACTIVE` with recent timestamp
4. **Rebalances tab:** effectiveness column shows positive delta for every row (price difference decreased)
5. **If a pool is STALE + WARN/CRITICAL:** global page highlights it as an action item
6. **VirtualPool:** no rebalancer panel, no rebalances tab (already true — just verify no regression)
7. **Hasura:** query `RebalanceEvent` table, verify `effectivenessRatio` = `(before - after) / before` for a known tx

---

## Estimated Effort

~4h (light indexer changes — no new RPC calls — + 3 dashboard components)

## Notes

- Effectiveness of `-0.12` (rebalance made oracle health worse) is theoretically possible in edge cases — render as red in the UI
- `rebalanceLivenessStatus = "STALE"` only flags when the pool is actually unhealthy — avoids false alarms on healthy pools that don't need rebalancing
- `RebalancerStat` entity deferred to Phase 2 (Ops screen) — keep scope tight
