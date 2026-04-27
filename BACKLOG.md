# Backlog

Tracks non-urgent follow-ups that don't fit into an in-flight PR. Move
items out of here as they're picked up (link the resulting PR/issue and
delete the entry).

---

## Indexer-backed oracle reporter detection (replace USDM_SYMBOLS leg-preference heuristic)

### Context

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

### Refs

- PR #232: introduced the heuristic Oracle Source tile.
- Cursor review on #232 flagged the heuristic as broken for FX pools where
  neither leg is USDm.
- Existing SortedOracles ABI exposes `getOracles(token: address) → address[]`
  — we just don't call it yet.
