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

**Binary only.** Confirmed 2026-04-02 after historical calibration against real pool data.

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

## 3x Codex Review — Findings (2026-04-02)

### 🔴 Blockers (all 3 passes agreed)

**B1. `healthScore24h`/`healthScore7d` on Pool is architecturally impossible in handlers.**
Updating a sliding 24h window requires subtracting aging-out contributions. The handler has no access to history — it can only `get` entities, not query historical ranges. The plan says "update on each event" but that's a dead end.
- **Decision:** Drop `healthScore24h`/`healthScore7d` from Pool. Rolling windows (24h/7d/30d) are UI-only, computed from raw OracleSnapshot history. If pool-list performance requires a fast path, add a separate nightly materializer job — not handler logic.

**B2. Dual OracleSnapshot writers are a correctness footgun.**
Both `SortedOracles.ts` and `fpmm.ts` update `pool.lastOracleSnapshotTimestamp` and accumulate health intervals. If both fire on the same block or same economic transition, you get double-counting, zero-duration intervals, or inconsistent state.
- **Decision:** Extract a single `recordHealthSample(pool, event, priceDifference, rebalanceThreshold)` shared helper. Both handler paths call it. Only one canonical path mutates time accumulators.

**B3. Same-block / same-timestamp events produce zero-duration intervals.**
Multiple events in one block share the same block timestamp. Zero-duration snapshots pollute the timeline and can cause divide-by-zero or meaningless accumulation.
- **Decision:** Only accumulate duration when `currentTimestamp > pool.lastOracleSnapshotTimestamp`. For same-timestamp events, update the current state but add nothing to accumulators. Still write the OracleSnapshot for auditability.

**B4. Rolling window computation needs the snapshot BEFORE `windowStart`.**
To compute a correct 24h/7d/30d score, you need to know what state was "in progress" at `windowStart`. Without the predecessor snapshot, the early portion of every window is treated as unknown.
- **Decision:** The UI always fetches two queries per pool detail view: (A) snapshots inside window ordered asc, (B) single latest snapshot before windowStart. Prepend B to A before computing. Spell this out in `health-score.ts`.

**B5. Sentinel `-1` inconsistency — `healthContribution` undefined for legacy rows.**
The plan defines `deviationRatio = "-1"` for legacy rows but doesn't define `healthContribution`. Using `"0.0"` for healthContribution is wrong (valid unhealthy value). Inconsistent sentinels will corrupt averages silently.
- **Decision:** Both `deviationRatio` and `healthContribution` use `"-1"` as the no-data sentinel. Add a `hasHealthData: Boolean!` field defaulting to `false`. All computation code checks `hasHealthData` before using values — no magic string parsing.

**B6. Schema conflates binary and weighted into single `healthContribution`.**
The formula has two distinct modes. Storing one `healthContribution` per snapshot is ambiguous — is it binary or weighted?
- **Decision:** Store both explicitly on OracleSnapshot: `healthValueBinary: String!` and `healthValueWeighted: String!`. Pool accumulators also split: keep `healthBinarySeconds` and add `healthWeightedMicros: BigInt!` (scaled integer, not float string — see B7).

**B7. `healthWeightedSum: String!` and all other ratio fields as strings are precision traps.**
String arithmetic across 750k+ events = rounding drift, inconsistent precision, silent accumulation bugs. `healthWeightedSum` after years of events could be meaningless.
- **Decision:**
  - `deviationRatio` and `healthValueBinary`/`healthValueWeighted` stay as strings on snapshots (for auditability/readability, stored to 6dp fixed precision)
  - `healthBinarySeconds: BigInt!` — clean integer, no precision issue
  - `healthWeightedMicros: BigInt!` — weighted contribution scaled by 1e6, accumulated as integer. Divide only at read time. Eliminates drift entirely.
  - `healthScore24h`/`healthScore7d` removed (see B1)
  - No float strings in accumulators.

---

### 🟡 Warnings (2/3 passes)

**W1. 300s staleness hardcode should use `pool.oracleExpiry`.**
Hardcoding 300s while pools have different oracle expiry configurations will misclassify healthy vs stale intervals.
- **Decision:** Use `pool.oracleExpiry` (already stored on Pool entity) as the freshness limit, with a safety cap of `min(pool.oracleExpiry, 3600n)` to avoid runaway carry. Document this in code.

**W2. Gap handling needs explicit interval-split math.**
For a gap from `t0` to `t1` where `t1 - t0 > freshnessLimit`:
```
healthySegment = [t0, t0 + freshnessLimit] → carry last state
staleSegment   = [t0 + freshnessLimit, t1] → h=0
```
This split must be applied identically in handler accumulators AND UI rolling-window code. Document and test it.

**W3. Weighted formula `1/d²` is uncalibrated.**
`d=1.01 → h=0.980`, `d=1.5 → h=0.444`, `d=2 → h=0.25`. Near threshold, barely penalized. Before showing weighted score to users, backtest against historical Celo data and compare to `1/d` and linear penalty bands.
- **Decision:** Implement both formula variants in `health-score.ts` but **only ship binary score in v1 UI**. Weighted stays as an internal/advanced metric only. Add to plan as a post-v1 toggle.

**W4. UX states: N/A vs 0% vs Collecting Data are not distinct.**
Three different states must render differently:
- `healthTotalSeconds = 0` → **N/A** (no data ever)
- `healthTotalSeconds > 0 && healthBinarySeconds = 0` → **0%** (tracked but always unhealthy)
- `healthTotalSeconds > 0, healthBinarySeconds > 0` → show score
- Tracking started recently (e.g. < 7d) → show score with `(X.Xd observed)` annotation
- **No nines labeling** until at least 7d of observed coverage

**W5. "All-time" label** — full reindex from genesis means all-time accumulators cover actual pool history, not just from feature launch. Label stays "All-time". ✅ Resolved 2026-04-02

**W6. Protocol health tile needs freshness filter and active-pool definition.**
Median across stale or dormant pools is theater. Define:
- Active = has `observedSeconds24h >= 12h` (50% coverage minimum)
- Exclude VirtualPools
- Liquidity-weighted median or simple median? (Simple is fine for v1, document the choice)

**W7. Client-side 30d raw snapshot query volume could be large.**
At 1 oracle event/minute, 30d = ~43,200 rows. At 5 events/minute = 216,000.
- **Decision:** Cap the pool detail query at 1,000 snapshots for the deviation chart. For health score computation, use the cap too — note in the UI if the full 30d window couldn't be covered. This is already bounded by actual pool oracle cadence (real pools update every few minutes at most).

---

### Updated Plan Decisions Summary

| Change | Before | After |
|---|---|---|
| `healthScore24h`/`7d` on Pool | pre-computed in handler | removed; UI-only rolling computation |
| Pool list health column source | `Pool.healthScore24h` | 24h query at render time (or separate light materializer) |
| Weighted accumulator | `healthWeightedSum: String!` | `healthWeightedMicros: BigInt!` (1e6 scale) |
| Snapshot fields | single `healthContribution: String!` | `healthValueBinary: String!` + `healthValueWeighted: String!` |
| Legacy sentinel | `deviationRatio = "-1"`, `healthContribution` undefined | both fields `"-1"` + `hasHealthData: Boolean!` |
| Staleness threshold | hardcoded 300s | `min(pool.oracleExpiry, 3600n)` |
| OracleSnapshot writers | two independent paths | single shared `recordHealthSample()` helper |
| Weighted score in UI | toggle in v1 | internal only in v1; toggle in v2 |
| "All-time" label | "All-time" | "All-time" (full reindex handles retroactive history) |
| Predecessor query | missing | required; always fetch latest snapshot before windowStart |

---

## Open Questions


1. **Retroactive history** — Full reindex from genesis computes health on all historical oracle events. All-time = true all-time from pool launch. ✅ 2026-04-02
2. **Minimum observation before showing nines** — 24h. Below that: show `X.X% (Yh observed)`, no nines label. ✅ 2026-04-02
3. **Stale time treatment** — Unhealthy. Gaps > `oracleExpiry` count against the pool. ✅ 2026-04-02
4. **Newly deployed pool with zero oracle history** — N/A until first oracle event. ✅ 2026-04-01
5. **Alerting thresholds** — hardcoded (95%) or configurable? → Stretch goal, decide when we get there.

---

## Plan Evaluation Against AGENTS.md Checklist (2026-04-02)

### Gaps identified and resolved:

**1. Old row backward compatibility**
- ~750k existing OracleSnapshot rows will be written with `deviationRatio = "0.0"` as Envio default on resync
- `d = 0.0` would be treated as healthy (d ≤ 1.0) — that's misleading
- **Decision:** Use `"-1"` as a sentinel for "no data" on old rows. UI computation filters out snapshots with `deviationRatio = "-1"`. Health score only covers spans where real data exists.
- In practice this means the all-time score starts accumulating from today's resync, not from pre-PR history.

**2. FPMM handlers also write OracleSnapshots**
- `UpdateReserves` and `Rebalanced` in `fpmm.ts` both create OracleSnapshot records
- These must also compute and write `deviationRatio` and `healthContribution`
- Pool accumulator update logic must also be invoked from these paths
- Added to Phase 2 scope explicitly.

**3. Degraded mode for health score panel**
- No oracle history → N/A badge (not zero, not 100%)
- Query failure → error state with message
- Pool accumulators are zero → N/A
- `deviationRatio = "-1"` snapshots → excluded from computation

**4. Deviation chart decoupled from computation**
- Chart uses the same snapshot query already fetched for 30d window
- No separate query. Chart is a visualization of `deviationRatio` over time from the same data slice.

**5. Pool list 24h score — avoid N per-pool queries**
- Fetching 24h snapshots for each of 30+ pools is expensive
- **Decision:** Add `healthScore24h: String!` and `healthScore7d: String!` pre-computed fields to Pool entity
- Updated in the handler on each oracle event (same place as accumulator update)
- Pool list reads these fields directly — no rolling window query needed at list level
- Pool detail still does the full rolling window computation (better precision, chart support)

### Invariants (explicit before coding)
1. `deviationRatio = "-1"` is the sentinel for "no data"; all computation code must filter these out
2. Pool `healthScore24h`/`healthScore7d` are best-effort rolling estimates updated at each oracle event
3. All-time score is computed from `healthBinarySeconds / healthTotalSeconds`; zero means N/A
4. Gaps ≤ 300s → carry last state; gaps > 300s → unhealthy for the stale portion
5. VirtualPools never receive health fields — they have no oracle data
6. Charts must not depend on paginated table state (use the standalone 30d window query)
7. Health computation is pure (no side effects); test independently of rendering
