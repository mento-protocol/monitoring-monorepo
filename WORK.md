# Feature Plan: Separate Trades from LP Events

**Branch:** `feat/separate-lp-trades`
**Date:** 2026-03-25

---

## 1. Findings

### What events fire during LP operations

When an LP calls `mint()` or `burn()` on an FPMM pool:

1. **`UpdateReserves`** — emitted by `_update()` before any position change
2. **`Swap`** — emitted by the internal `_rebalanceSwap()` call if the pool needs rebalancing to absorb the new liquidity (not always present)
3. **`UpdateReserves`** — again after rebalancing
4. **`Mint`** or **`Burn`** — the actual LP event

Critical ordering fact: when a rebalance swap occurs during LP, the `Swap` event is emitted **before** `Mint`/`Burn` in the same transaction's log order. Envio processes events in log order, so the `FPMM.Swap` handler runs first and stores the `SwapEvent`, then `FPMM.Mint`/`FPMM.Burn` runs.

### Current storage

**`SwapEvent`** (`schema.graphql:100`):
- `id`, `poolId`, `sender`, `recipient`, `amount0In/Out`, `amount1In/Out`, `txHash`, `blockNumber`, `blockTimestamp`
- **No field** to distinguish user trades from LP-triggered rebalance swaps

**`LiquidityEvent`** (`schema.graphql:114`):
- `id`, `poolId`, `kind` (`MINT`/`BURN`), `sender`, `recipient`, `amount0`, `amount1`, `liquidity`, `txHash`, `blockNumber`, `blockTimestamp`
- Stores `txHash` — the same `txHash` that any co-transaction Swap would have

**Key link:** If a `SwapEvent.txHash == LiquidityEvent.txHash` for the same pool, the swap was LP-triggered.

### Volume contamination

- `Pool.swapCount` and `Pool.notionalVolume0/1` are incremented in `pool.ts:166-168` for every `swapDelta`, which is passed from the Swap handler for all swaps including LP-triggered ones.
- `PoolSnapshot.swapCount/swapVolume0/swapVolume1` likewise count all swaps.
- The 24h volume displayed in the UI (`volume.ts:50`) and swap counts in `sumFpmmSwaps24h` are therefore inflated by LP-triggered rebalance swaps.

### Sender/recipient heuristic (why it's unreliable)

An LP-triggered swap has the pool itself as `sender` or the LP strategy contract — but this varies and the same addresses may appear in legitimate user trades routed through contracts. A txHash join is the only reliable discriminator.

### Envio entity access limitations

In Envio handlers, entities can only be retrieved by their `id` (the primary key). There is no query-by-field within a handler. This means in the `Mint` handler we cannot do "find SwapEvent where txHash = X" — we need to know the SwapEvent's `id` ahead of time, or use a secondary lookup entity.

---

## 2. Proposed Approach

### Option A — Query-time txHash join (no indexer changes)

Filter LP swaps in the UI by fetching `LiquidityEvent` txHashes alongside `SwapEvent` and excluding matches client-side.

- **Pros:** Zero indexer changes; ships fast.
- **Cons:**
  - Pagination breaks: fetching N swaps then filtering gives < N results, requiring client-side logic to fill pages.
  - Volume metrics (`Pool.swapCount`, `PoolSnapshot.swapVolume`) stay wrong and can't be fixed UI-side.
  - The 24h volume card on the pools list page remains inflated.

### Option B — `isLpSwap` flag on SwapEvent with TxHashIndex lookup (indexer change) ✅ Recommended

Add an `isLpSwap: Boolean!` field to `SwapEvent`. In the Swap handler, also store a cheap lookup entity. In the Mint/Burn handler, look up the index and backfill `isLpSwap = true` on the matching swap.

**Schema additions:**

```graphql
type SwapEvent ... {
  ...existing fields...
  isLpSwap: Boolean!   # true when swap was triggered by a Mint/Burn in same tx
}

# Temporary index: allows Mint/Burn handler to find a Swap by txHash+poolId
# without a full table scan. Can be deleted after use (we overwrite same id).
type SwapTxIndex {
  id: ID!           # "{chainId}:{poolId}:{txHash}"
  swapEventId: String!
}
```

**Indexer handler changes (`fpmm.ts`):**

In `FPMM.Swap.handler`:
```ts
const swap: SwapEvent = { ...existing fields..., isLpSwap: false };
context.SwapEvent.set(swap);

// Store lookup for Mint/Burn handlers to backfill
context.SwapTxIndex.set({
  id: `${event.chainId}:${poolId}:${event.transaction.hash}`,
  swapEventId: id,
});
```

In `FPMM.Mint.handler` and `FPMM.Burn.handler` (after storing the LiquidityEvent):
```ts
const indexId = `${event.chainId}:${poolId}:${event.transaction.hash}`;
const swapIndex = await context.SwapTxIndex.get(indexId);
if (swapIndex) {
  const existingSwap = await context.SwapEvent.get(swapIndex.swapEventId);
  if (existingSwap) {
    context.SwapEvent.set({ ...existingSwap, isLpSwap: true });
  }
}
```

**Volume metric corrections:**

Currently `Pool.swapCount` and `Pool.notionalVolume0/1` count all swaps. With the backfill approach, by the time Mint/Burn fires, we've already incremented these counters in the Swap handler. We need to undo the increment:

Add `tradeSwapCount`, `tradeVolume0`, `tradeVolume1` fields to `Pool` and `PoolSnapshot` — OR subtract in the Mint/Burn handler:

```ts
// In Mint/Burn handler, after marking isLpSwap = true:
if (swapIndex && existingSwap) {
  const vol0 = existingSwap.amount0In > 0n ? existingSwap.amount0In : existingSwap.amount0Out;
  const vol1 = existingSwap.amount1In > 0n ? existingSwap.amount1In : existingSwap.amount1Out;
  // Subtract LP swap volume from pool cumulative
  const pool = await context.Pool.get(poolId);
  if (pool) {
    context.Pool.set({
      ...pool,
      swapCount: pool.swapCount - 1,
      notionalVolume0: pool.notionalVolume0 - vol0,
      notionalVolume1: pool.notionalVolume1 - vol1,
    });
  }
  // Same for snapshot...
}
```

This keeps the existing `Pool.swapCount/notionalVolume` as "trade-only" metrics without adding new fields. However it requires careful delta tracking.

**Alternative for volume:** Add new parallel fields `Pool.tradeSwapCount`, `Pool.tradeVolume0/1`, `Pool.tradeMintCount`, `Pool.tradeBurnCount` and only increment them for non-LP swaps. Keep existing fields for total activity. This avoids subtract logic but doubles the fields.

**Recommendation:** Use the subtract approach to keep the schema clean. The `PoolSnapshot` subtraction is slightly tricky (we need to find the right hourly bucket) but doable.

### Option C — `isLpSwap` flag set eagerly in Swap handler via LiquidityEvent lookup

Check whether a `LiquidityEvent` with matching txHash already exists in the Swap handler. **Not viable** because Swap fires before Mint/Burn — the LiquidityEvent doesn't exist yet when Swap runs.

---

## 3. Schema Changes

### `schema.graphql`

```diff
type SwapEvent @index(fields: ["poolId", "blockTimestamp"]) {
  id: ID!
  poolId: String! @index
  sender: String!
  recipient: String!
  amount0In: BigInt!
  amount1In: BigInt!
  amount0Out: BigInt!
  amount1Out: BigInt!
  txHash: String!
  blockNumber: BigInt!
  blockTimestamp: BigInt! @index
+ isLpSwap: Boolean!
}

+ type SwapTxIndex {
+   id: ID!          # "{chainId}:{poolId}:{txHash}"
+   swapEventId: String!
+ }
```

`Pool` and `PoolSnapshot` changes depend on the volume correction strategy chosen (new fields vs subtract). Lean towards keeping existing fields as "trade-only" via subtract for minimal schema churn.

---

## 4. UI Changes

### Swaps tab (`pool/[poolId]/page.tsx`)

- Update `POOL_SWAPS` query to add `isLpSwap` to the selection set
- Filter: `swaps.filter(s => !s.isLpSwap)` before rendering the table
- Show a small info line: "X LP-rebalance swaps hidden. View them in the Liquidity tab."
- **Or** add a toggle: "Show LP swaps" (default off)

### Liquidity tab

- Update `POOL_LIQUIDITY` query to also fetch `SwapEvent` for the same pool+txHashes
- For each LiquidityEvent row, check if there's a matching swap (same txHash)
- If yes, add a "⇄" swap icon/badge showing the swap amounts inline

### Trades/Swaps tab rename

The tab is currently called "swaps". Consider renaming to "trades" to signal intent. Or add a subtitle "User trades (LP swaps excluded)".

### Volume metrics

- `POOL_SNAPSHOTS` — once `PoolSnapshot.swapVolume0/1` and `swapCount` are corrected at the indexer level, the 24h volume numbers fix themselves automatically.
- `Pool.notionalVolume0/1` displayed on the pools list also fixes automatically.

### Queries (`lib/queries.ts`)

```diff
export const POOL_SWAPS = `
  query PoolSwaps($poolId: String!, $limit: Int!) {
    SwapEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockNumber: desc }
      limit: $limit
    ) {
-     id poolId sender recipient
+     id poolId sender recipient isLpSwap
      amount0In amount1In amount0Out amount1Out
      txHash blockNumber blockTimestamp
    }
  }
`;
```

Note: applying `where: { isLpSwap: { _eq: false } }` in the query is cleaner than client-side filtering and makes pagination correct. This is the preferred approach.

---

## 5. Implementation Phases

### Phase 1 — Indexer: schema + handler changes

1. Add `isLpSwap: Boolean!` to `SwapEvent` in `schema.graphql`
2. Add `SwapTxIndex` type to `schema.graphql`
3. In `FPMM.Swap.handler`:
   - Set `isLpSwap: false` on new SwapEvent
   - Store `SwapTxIndex` entity
4. In `FPMM.Mint.handler` and `FPMM.Burn.handler`:
   - Look up `SwapTxIndex` by `chainId:poolId:txHash`
   - If found, backfill SwapEvent with `isLpSwap: true`
   - Correct Pool and PoolSnapshot volume/count by subtracting the LP swap's contribution
5. Run `pnpm codegen` to regenerate types
6. Test locally with `pnpm dev`

**Risk:** Volume counters become temporarily inconsistent during re-indexing until the full backfill completes. This is acceptable since this is a dev/monitoring tool.

**Risk:** If Envio doesn't guarantee strict log-order processing across concurrent handlers, the `SwapTxIndex` lookup in Mint/Burn might race. In practice Envio processes events sequentially by log index within a block, so this should be safe.

### Phase 2 — UI: trades view

1. Update `POOL_SWAPS` query to filter `isLpSwap: { _eq: false }` server-side
2. Add `isLpSwap` to the SwapEvent type in `lib/types.ts`
3. Add subtle note in SwapsTab: "LP-rebalance swaps are excluded."

### Phase 3 — UI: liquidity tab with linked swap info

1. Update `POOL_LIQUIDITY` query to also fetch `SwapEvent` where `isLpSwap: true` for the same pool (or filter by txHash match)
2. In `LiquidityTab`, join events on txHash and display the linked swap inline per row

### Phase 4 — Home page / global volume

1. Verify `sumFpmmSwaps24h` in `volume.ts` reads from `PoolSnapshot.swapCount` — once Phase 1 corrects the snapshot counts, this flows through automatically.
2. No code change needed if Phase 1 correctly adjusts the snapshot.

---

## 6. Edge Cases & Risks

| Case | Notes |
|------|-------|
| LP mint/burn with NO rebalance swap | Most common case — no `Swap` event emitted, no `SwapTxIndex` created, no issue |
| Multiple swaps in same tx (unrelated) | Possible if a router batches; but FPMM only emits one Swap per internal rebalance call. The `chainId:poolId:txHash` key is pool-scoped so won't collide across pools in a batch tx |
| Re-indexing from scratch | All events re-processed in order; `isLpSwap` flags will be set correctly |
| `SwapTxIndex` accumulation | This entity grows indefinitely (one entry per LP-triggered swap). Consider a cleanup mechanism, or accept it as a small lookup table (LP swaps are infrequent) |
| Snapshot volume subtract underflow | If somehow subtract produces negative volumes, clamp to 0n |
| Historical data accuracy | After deployment, re-indexing will be needed to backfill `isLpSwap` correctly on existing data. The current data has no `isLpSwap` field, so all existing swaps will default to `false` post-migration if not re-indexed |
| UI pagination | Querying `limit: 25` with `isLpSwap: false` server-side gives correct pages |

---

## 7. Open Questions

1. **How frequent are LP-triggered swaps in practice?** If rare (< 1% of all swaps), the volume inflation is minor and Phase 1 can be deprioritised. Check on-chain data to quantify.

2. **Should `SwapTxIndex` be a permanent entity or deleted after use?** Deleting after backfill would keep the DB lean but Envio may not support entity deletion efficiently.

3. **Volume field strategy**: Keep existing `swapCount/notionalVolume` as trade-only (subtract LP swaps) vs add parallel `totalSwapCount/totalVolume` fields. The subtract approach is cleaner but has subtle "undo" logic. The parallel fields approach is more explicit.

4. **Rename "swaps" tab to "trades"?** Low risk, high clarity. Do it in Phase 2.
