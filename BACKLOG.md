# Backlog

Tracks non-urgent follow-ups that don't fit into an in-flight PR. Move
items out of here as they're picked up (link the resulting PR/issue and
delete the entry).

---

## Pool detail: replace Rebalance Threshold tile with Breaker tile (config + live trip state + cooldown)

### Background

The Pool Config panel's **Rebalance Threshold** tile currently shows just a
static % (e.g. `33.33%`) — it tells operators when a rebalance gets rewarded
but doesn't say anything about whether trading is currently gated. The
authoritative "can I swap right now?" answer lives in the BreakerBox circuit
breakers attached to the pool's `referenceRateFeedID`. Surfacing breaker
state — config + live trip status + cooldown countdown — is a higher-signal
KPI for the same screen real estate.

### What to display

Three states for the tile:

1. **Healthy:**

   ```
   Breaker
   ✓ Trading enabled
   Median Δ ≤ 0.5% / 15m cooldown
   ```

2. **Tripped, within cooldown:**

   ```
   Breaker
   ✗ Halted (Median Δ)        ← red
   Tripped 3m ago / 12m cooldown remaining
   ```

3. **Tripped, past cooldown but rate still volatile** (real state — reset
   requires both cooldown elapsed AND `shouldReset()` returning true):
   ```
   Breaker
   ✗ Halted (Median Δ)
   Tripped 17m ago / awaiting calm
   ```

`tradingMode` is a **bitmask, not a bool** (`0` enabled / `1` inflow-only /
`2` outflow-only / `3` halted) — render the exact mode, don't collapse to
binary. With multiple breakers wired in, the headline shows the
most-restrictive aggregate; a tooltip on the ⓘ enumerates each breaker's
individual state. For pools where `MarketHoursBreaker` is the one tripping
(FX weekend), prefer the existing `Markets closed (FX)` copy and skip the
cooldown row.

### Why this can't be UI-only

We need (a) historical "tripped N min ago" — requires indexed events,
not just a render-time RPC snapshot, and (b) a live cooldown countdown
that ticks (the OLS cooldown UI on `page.tsx:2309–2425` is the pattern to
mirror). RPC-at-render covers neither.

### Implementation

**Indexer (`indexer-envio/`):**

1. Vendor `BreakerBox.json` ABI from
   `node_modules/@mento-protocol/contracts/abis/` into `indexer-envio/abis/`.
2. New handlers for the BreakerBox events:
   `BreakerTripped`, `ResetSuccessful`, `ResetAttemptCriteriaFail`,
   `ResetAttemptNotCool`, `TradingModeUpdated`, `BreakerStatusUpdated`,
   `BreakerAdded/Removed`, `RateFeedAdded/Removed`.
3. New handlers for the config-update events on each breaker contract:
   `RateChangeThresholdUpdated`, `RateFeedCooldownTimeUpdated`,
   `ReferenceValueUpdated`, `SmoothingFactorSet`, plus the global
   `Default*Updated` counterparts.
4. New schema entities:

   ```graphql
   type BreakerConfig {
     id: ID! # `<chainId>-<breaker>-<rateFeedID>`
     chainId: Int!
     breakerAddress: String!
     breakerKind: String! # MEDIAN_DELTA / VALUE_DELTA / MARKET_HOURS
     rateFeedID: String!
     enabled: Boolean!
     rateChangeThreshold: BigInt # null for MarketHours
     cooldownSeconds: Int # null for MarketHours
     referenceValue: BigInt # ValueDelta only
     smoothingFactor: BigInt # MedianDelta only
   }
   type BreakerTripEvent {
     id: ID! # `<chainId>-<breaker>-<rateFeedID>-<blockNumber>`
     chainId: Int!
     breakerAddress: String!
     rateFeedID: String!
     trippedAt: BigInt!
     resetAt: BigInt # null while still tripped
     tradingMode: Int!
     txHash: String!
   }
   ```

5. Extend `Pool` entity: `tradingMode: Int!` (default 0),
   `lastBreakerTripAt: BigInt`.

**UI (`ui-dashboard/src/components/pool-config-panel.tsx`):**

- Replace the Rebalance Threshold `<Stat>` with a `<BreakerTile>` that joins
  on `pool.referenceRateFeedID` to the new `BreakerConfig` + the latest
  `BreakerTripEvent` row.
- Live cooldown countdown reuses the OLS cooldown's `useEffect`/tick pattern
  (already wired at `page.tsx:2309–2425`).
- Bitmask lookup: `0 → "Trading enabled"`, `1 → "Inflow-only"`,
  `2 → "Outflow-only"`, `3 → "Halted"`.

### Tile layout decision

Two equivalent options for the 5-column Pool Config row:

- **Replace Rebalance Threshold**: one less config tile, but Rebalance
  Threshold has its own audience (rebalance-reward economics). May want to
  keep it.
- **Drop Rebalance Strategy instead**: low-signal (operators rarely need
  the strategy contract address); move it to a tooltip on the pool address
  in the header. Final row becomes:
  `Swap Fee · Oracle Source · Breaker · Rebalance Threshold · Rebalance Reward`.

### Ship strategy

Per `project_schema_single_pr_preference.md`: this is schema-required UI
work, so it ships as one PR with deploy sequencing — indexer from branch
tip → re-sync against branch → merge → promote.

### References

- [`BreakerBox.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/BreakerBox.sol)
- [`MedianDeltaBreaker.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/breakers/MedianDeltaBreaker.sol)
- [`ValueDeltaBreaker.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/breakers/ValueDeltaBreaker.sol)
- Reset is **not** auto-on-time alone: `tryResetBreaker` requires
  `block.timestamp ≥ lastUpdatedTime + cooldown` AND
  `breaker.shouldReset()` returning true, and only fires on the next
  SortedOracles report. The "awaiting calm" UI state captures this.
- BreakerBox aggregate via `getRateFeedTradingMode(rateFeedID) → uint8` is
  bitwise-OR across enabled breakers; SortedOracles surfaces it and
  BiPoolManager refuses the gated swap direction(s). Render the bitmask,
  don't collapse to bool.

---

## Indexer-backed oracle reporter detection (replace USDM_SYMBOLS leg-preference heuristic)

### Origin

The pool detail page's **Oracle Source** tile (introduced in PR #232) labels the
upstream oracle by guessing from the pool's token symbols: it picks the non-USDm
leg first and falls back to the USDm leg, then looks up the result in a static
`CHAINLINK_FEEDS` map. This breaks for pools where neither leg is USDm but a leg
is pegged to a different fiat (`USDC/GBPm` mislabels as USDC/USD; `AUSD/EURm` on
Monad has the same problem). Cursor flagged this on #232 and we declined to
widen scope there.

### Goal

Surface the **actual upstream oracle adapter** that authoritatively reports
rates to a pool's `referenceRateFeedID` in SortedOracles (Chainlink relayer /
RedStone relayer / BridgedAdapter / manual reporter / etc.) — independent of
token-symbol heuristics.

### Proposed approach (indexer-backed)

1. **New `RateFeed` entity** in `indexer-envio/schema.graphql`:

   ```graphql
   type RateFeed {
     id: ID! # `<chainId>-<feedAddress>`
     chainId: Int!
     feedAddress: String!
     reporters: [String!]! # contract addresses authorized to report
     reporterTypes: [String!]! # CHAINLINK / REDSTONE / BRIDGED / MANUAL / UNKNOWN
     pair: String # e.g. "USDC/USD" — derived from the adapter
   }
   ```

2. **Index SortedOracles `OracleAdded` / `OracleRemoved` events** in
   `indexer-envio/src/handlers/sortedOracles.ts` to maintain the `reporters`
   array. (Currently the file handles `OracleReported` / `MedianUpdated` /
   `*ExpirySet` but not membership changes.)

3. **Static reporter → adapter type lookup** in `shared-config` (or a new
   `indexer-envio/src/oracleAdapters.ts` consumed by both the indexer and the
   dashboard via the existing `@mento-protocol/monitoring-config` workspace
   package). Maps known reporter contract addresses per chain to their adapter
   type + pair label. Self-healing — adding a new adapter is a one-row config
   bump.

4. **Wire UI** to read `pool → referenceRateFeedID → RateFeed →
reporterTypes/pair` and render `Chainlink USDC/USD` / `RedStone EUR/USD` /
   `BridgedAdapter (axlUSDC)` / `Manual reporter` based on the indexed truth,
   dropping the USDM_SYMBOLS heuristic in `pool-config-panel.tsx`.

### Non-goals

- Probing adapter contract methods (`aggregator()`, `dataServiceId()`) at
  runtime — bytecode-signature detection is out of scope; static labels are
  simpler and more reliable.
- Backfilling historical reporter changes — first scan can replay `OracleAdded`
  from genesis as part of the indexer redeploy.

### Stepping-stone option (UI + RPC) — alternative

If the indexer change feels heavy, a v0 can ship in the dashboard alone: at
render time call `SortedOracles.getOracles(referenceRateFeedID)` via RPC, then
look up adapter types in the same static map. The static map is reusable for
the indexer-backed approach — so the v0 work isn't throwaway. Pick one based on
cost vs. correctness/latency tradeoff.

### Affected files (indexer path)

- `indexer-envio/schema.graphql` (add `RateFeed` entity)
- `indexer-envio/src/handlers/sortedOracles.ts` (handle `OracleAdded` /
  `OracleRemoved`)
- `shared-config/src/oracleAdapters.ts` (new: static reporter → type/pair map)
- `ui-dashboard/src/components/pool-config-panel.tsx` (replace heuristic with
  indexed lookup)
- `ui-dashboard/src/components/__tests__/pool-config-panel.test.tsx` (regression
  coverage on FX pools)

### Notes

- PR #232: introduced the heuristic Oracle Source tile.
- Cursor review on #232 flagged the heuristic as broken for FX pools where
  neither leg is USDm.
- Existing SortedOracles ABI exposes `getOracles(token: address) → address[]`
  — we just don't call it yet.
