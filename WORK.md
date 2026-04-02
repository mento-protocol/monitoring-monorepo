# Pool Health Score — Feature Plan

**Branch:** `feat/pool-health-score`
**Status:** in progress
**Last updated:** 2026-04-01

---

## Goal

Design a pool health metric inspired by availability SLAs ("nines of availability"). Each FPMM pool gets a score representing how much of the time it has been close to its perfectly balanced (equilibrium) state.

VirtualPools: **N/A** (no oracle data, same pattern as existing oracle health badges).

---

## Mental Model

A pool is "healthy" when its reserve ratio matches the oracle price. Deviation is measured as:

```
deviationRatio = priceDifference / rebalanceThreshold
```

- `d ≤ 1.0` → within threshold → healthy
- `d > 1.0` → past threshold → degraded (should have rebalanced)

**Health contribution per snapshot:**

```
h(d) = d ≤ 1.0 ? 1.0 : min(1.0, 1/d²)
```

Quadratic inverse penalizes deep/sustained deviations hard, but brief spikes don't crater the score.

**Score formula (time-weighted integral):**

```
score = Σ( h(dᵢ) × durationᵢ ) / total_window_seconds
```

Two score variants:
- **Binary** — `h(d) = d ≤ 1.0 ? 1.0 : 0.0` → maps directly to "nines of availability"
- **Weighted** — quadratic inverse as above → penalizes severity of deviation

Both are shown in the UI; binary leads (it's the intuitive "uptime" number).

---

## Gap Handling Decision

When oracle hasn't updated (gap between snapshots):
- **Carry last known state** — pool is still sitting at whatever deviation it was at
- **Exception:** if gap > 300s (oracle staleness threshold), treat gap as unhealthy (h=0)

Open question (pending Philip input): should a pool with zero oracle history (newly deployed) default to N/A or 100% until first oracle event?
→ **Recommendation:** N/A until at least one oracle event is indexed.

---

## Time Windows

Four windows shown in parallel:
- 24h (rolling)
- 7d (rolling)
- 30d (rolling)
- All-time (since pool deployment / first oracle event)

---

## Architecture: Hybrid Indexer + UI

| Concern | Where | Why |
|---|---|---|
| `deviationRatio` + `healthContribution` per snapshot | Indexer | Computed once at write time; reused by all windows |
| All-time running accumulators | Indexer (on `Pool`) | Efficient; avoids full history scan |
| Rolling window scores (24h/7d/30d) | UI | Envio can't do windowed aggregation; 720 records max for 30d |

---

## Phase 1 — Indexer: Schema Changes

### `schema.graphql` additions

```graphql
# OracleSnapshot — two new fields computed at write time
type OracleSnapshot {
  # ... existing fields unchanged ...
  deviationRatio: String!       # priceDifference / rebalanceThreshold, e.g. "1.2345"
  healthContribution: String!   # min(1.0, 1/d²), e.g. "0.4444" (or "1.0" if d ≤ 1.0)
}

# Pool — all-time health accumulators (FPMM only)
type Pool {
  # ... existing fields unchanged ...
  healthTotalSeconds: BigInt!           # cumulative seconds with oracle coverage
  healthBinarySeconds: BigInt!          # seconds where deviationRatio ≤ 1.0
  healthWeightedSum: String!            # Σ(contribution × durationSeconds) as decimal
  lastOracleSnapshotTimestamp: BigInt!  # timestamp of most recent oracle event
  lastDeviationRatio: String!           # deviationRatio of most recent snapshot
  lastHealthContribution: String!       # healthContribution of most recent snapshot
}
```

Default values for VirtualPools / pre-first-event state:
- `healthTotalSeconds: 0`, `healthBinarySeconds: 0`, `healthWeightedSum: "0.0"`
- `lastOracleSnapshotTimestamp: 0`, `lastDeviationRatio: "0.0"`, `lastHealthContribution: "1.0"`

---

## Phase 2 — Indexer: Handler Changes

**File:** `indexer-envio/src/handlers/SortedOracles.ts` (or wherever MedianUpdated lands)

On each oracle event for an FPMM pool:

1. **Compute `deviationRatio`:**
   ```typescript
   // priceDifference and rebalanceThreshold are already on the Pool entity
   const d = pool.rebalanceThreshold > 0
     ? Number(pool.priceDifference) / pool.rebalanceThreshold
     : 0
   const deviationRatio = d.toFixed(6)
   ```

2. **Compute `healthContribution`:**
   ```typescript
   const hWeighted = d <= 1.0 ? 1.0 : Math.min(1.0, 1 / (d * d))
   const healthContribution = hWeighted.toFixed(6)
   ```

3. **Finalize previous snapshot's duration into all-time accumulators:**
   ```typescript
   if (pool.lastOracleSnapshotTimestamp > 0) {
     const duration = currentTimestamp - pool.lastOracleSnapshotTimestamp
     // Apply staleness: if gap > 300s, treat as unhealthy (h=0)
     const effectiveDuration = duration <= 300n ? duration : 300n
     const unhealthyGap = duration > 300n ? duration - 300n : 0n

     healthTotalSeconds += duration
     // Binary: last state was healthy if lastDeviationRatio <= 1.0
     if (parseFloat(pool.lastDeviationRatio) <= 1.0) {
       healthBinarySeconds += effectiveDuration
     } else {
       healthBinarySeconds += 0n  // was unhealthy
     }
     // Weighted: contribution × effective duration
     const contrib = parseFloat(pool.lastHealthContribution)
     healthWeightedSum += contrib * Number(effectiveDuration)
     // Stale gap always contributes 0 to weighted sum (already excluded above)
   }
   ```

4. **Write `OracleSnapshot`** with new fields.

5. **Update `Pool`** accumulators + `lastOracleSnapshotTimestamp`, `lastDeviationRatio`, `lastHealthContribution`.

---

## Phase 3 — UI: Computation Library

**New file:** `ui-dashboard/src/lib/health-score.ts`

```typescript
export interface HealthScoreResult {
  binary: number       // 0–100 (percentage of time within threshold)
  weighted: number     // 0–100 (deviation-penalized percentage)
  nines: string        // "2 nines", "3 nines", "4 nines", etc.
  coveredSeconds: number
  totalWindowSeconds: number
  hasData: boolean
}

// Compute from raw OracleSnapshot records (sorted asc by timestamp)
export function computeHealthScore(
  snapshots: OracleSnapshotHealthFragment[],
  windowStart: number,   // unix seconds
  windowEnd: number      // unix seconds (usually Date.now() / 1000)
): HealthScoreResult

// Map binary percentage → nines label
// 99.0–99.9% → "2 nines", 99.9–99.99% → "3 nines", etc.
export function toNines(binaryPct: number): string
```

**Gap handling in computation:**
- Gap before first snapshot in window → carry state from last snapshot before windowStart (query one extra record before windowStart)
- Gap between snapshots ≤ 300s → carry last state
- Gap > 300s → treat stale portion (>300s) as h=0

**GraphQL fragment:**

```graphql
fragment OracleSnapshotHealth on OracleSnapshot {
  timestamp
  deviationRatio
  healthContribution
}
```

**Query strategy:** Fetch `windowStart = now - 30d` for all rolling windows in one request (max ~720 records per pool for 30d at hourly oracle cadence). UI slices into 24h/7d/30d sub-windows client-side.

---

## Phase 4 — UI: Components

### Pool list — new `Health Score` column

- Value: binary 24h score as `99.92%`
- Color coding:
  - 🟢 ≥ 99% (2+ nines)
  - 🟡 ≥ 95%
  - 🔴 < 95%
- Tooltip: "% of time within rebalance threshold (last 24h) · Weighted: 98.34%"
- N/A badge for VirtualPools

### Pool detail — Health Score panel

New section in the existing Health tab (or adjacent card):

```
┌──────────────────────────────────────────────────────┐
│  Pool Health Score                                   │
│                                                      │
│  24h        7d         30d        All-time           │
│  99.91%     98.43%     97.12%     94.50%             │
│  ~3 nines   ~2 nines   ~2 nines   ~2 nines           │
│                                                      │
│  [Binary]  [Weighted]   ← toggle                    │
│                                                      │
│  [Deviation ratio over time — Plotly line chart]     │
│  Threshold band at y=1.0, area above red (α=0.15)   │
└──────────────────────────────────────────────────────┘
```

All-time score sourced from `Pool.healthBinarySeconds / Pool.healthTotalSeconds` (no snapshot query needed).

### Global page — protocol health tile

New summary tile: **Protocol Health (24h)** = median binary score across active FPMM pools.
(Median preferred over mean — one bad pool shouldn't tank the protocol-level number.)

---

## Phase 5 — Alerting (stretch goal)

Extend existing Discord alert infra:
- Alert when pool binary 24h score drops below configurable threshold (e.g. 95%)
- Aggregate alert when protocol median drops below threshold

---

## Execution Order

| # | Task | File(s) | Notes |
|---|---|---|---|
| 1 | Add `deviationRatio` + `healthContribution` to `OracleSnapshot` schema | `schema.graphql` | |
| 2 | Add all-time accumulator fields to `Pool` schema | `schema.graphql` | |
| 3 | Handler: compute + write new `OracleSnapshot` fields | `SortedOracles.ts` | |
| 4 | Handler: finalize duration → update `Pool` accumulators | `SortedOracles.ts` | |
| 5 | Unit tests: deviationRatio math, accumulator logic, gap/staleness handling | `*.test.ts` | |
| 6 | `health-score.ts` utility + tests | `ui-dashboard/src/lib/` | Pure functions, easy to test |
| 7 | Pool detail: Health Score panel + deviation chart | UI | |
| 8 | Pool list: Health Score column | UI | |
| 9 | Global page: protocol health aggregate tile | UI | |
| 10 | Deploy indexer → update endpoint → update Vercel env var | ops | New endpoint, not in-place |

---

## Open Questions

1. **Newly deployed pool with zero oracle history** — N/A until first oracle event. ✅ Confirmed 2026-04-01.
2. **Alerting thresholds** — hardcoded (95%) or configurable? → Stretch goal, decide when we get there.
