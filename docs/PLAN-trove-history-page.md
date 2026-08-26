---
title: Trove History Page Design
status: active
owner: eng
canonical: false
last_verified: 2026-08-26
doc_type: plan
scope: indexer-envio/ui-dashboard
review_interval_days: 180
garden_lane: notes-plans-archive
---

# Trove History Page Design

Design for a per-trove history page on the monitoring dashboard: click a trove
on `/cdps/[symbol]` and land on a page that shows everything that happened to
that position over time, instead of leaving for a block explorer or the Mento
app. This document is the step-1 design only; no page is implemented yet.

Non-canonical plan. Every code/schema claim below was verified on 2026-08-26
against `mento-protocol/bold` @ `1649143`, the live indexer schema/handlers,
and the production GraphQL endpoint. Re-verify before implementing.

## The motivating case (ticket #0754)

> "User said their position has decreased a lot, their initial collateral was
> 40k USDm and borrowed 25k GBPm. `0xcca0a99b94529493ddffe7c61a3ae454828cd3bb`"

Reconstructing the answer today took ~345 chunked `eth_getLogs` calls against
forno (5,000-block range cap), manual ABI decoding of three TroveManager
topics, and cross-checking against indexer cumulatives. The answer:

- Opened 2026-08-06: 39,955 USDm collateral, 25,000 GBPm borrowed
  (+12.87 GBPm upfront fee) at 0.5% interest — the lowest live rate on the
  GBPm market, i.e. first in the redemption queue once the lone 0.2% trove
  ahead of it was exhausted.
- 2026-08-25, 18:13–21:11 UTC: five protocol rebalancing redemptions
  (`isRebalance`, via `CDPLiquidityStrategy`) repaid 18,450.82 GBPm of debt
  and took 25,163.91 USDm of collateral at the oracle GBP/USD rate, crediting
  12.59 USDm of redemption fees to the trove. Position size fell 63%; net
  equity at oracle prices rose ~11 USDm (5,814 → 5,825). ICR rose 117% → 165%.
- 2026-08-26: the user moved the rate to 1.6%, added 30,000 USDm, and
  reborrowed 21,500 GBPm.

The user experienced a forced deleverage at par, not a loss. The page must
make that answer visible in one glance: what hit the trove, when, how much,
why this trove, and what it cost.

The hard part was entirely per-trove redemption attribution: `RedemptionEvent`
has no trove id, the `Trove` entity stores only lifetime cumulatives, and one
instance-level redemption split across two troves (block 75,780,824: 9,968.39
GBPm total, 5,021.78 to this trove). Everything else was a single indexer
query. That gap defines the indexer work below.

## Goals

1. A support agent or user pastes an owner address or clicks a trove row and
   gets the full ledger of that trove: opens, adjusts, rate changes, interest,
   redemptions (user vs rebalance), liquidation, zombie transitions, close.
2. Each ledger row shows signed debt/coll deltas, fees, the resulting
   debt/coll after the row, and a tx link.
3. A redemption-impact summary and a "why me" panel explain the mechanism
   (queue position by interest rate) in product terms.
4. The page answers ticket-#0754-class questions with zero RPC archaeology.

### Non-goals (v1)

- Historical redemption-queue rank ("who shielded me at the time"). Only the
  current rate ladder is reconstructable from indexed entities; rank-at-event
  needs bracket snapshots that do not exist. Show current rank plus prose.
- Ownership provenance beyond `owner`/`previousOwner` (NFT transfer history is
  single-slot today).
- Per-trove SP-offset vs redistribution split inside a liquidation (on-chain
  the split is only aggregate per `batchLiquidateTroves` call).
- Liquidation-surplus claim tracking (CollSurplusPool is not indexed at all;
  candidate follow-up, not v1).
- Batch-managed troves get correct rendering of what exists, and nothing
  more: production has zero `InterestBatch` rows and zero troves with
  `interestBatchId` set (verified 2026-08-26 on all three markets), so batch
  ledger work would be speculative. The design keeps a seam for it.

## On-chain event surface (bold fork)

Authority: `contracts/src/Interfaces/ITroveEvents.sol` and
`contracts/src/TroveManager.sol` in `mento-protocol/bold`. All trove lifecycle
events are emitted by TroveManager (BorrowerOperations delegates back via
`on*` callbacks). The fork keeps upstream Liquity v2 event signatures and
`Operation` ordinals unchanged, so upstream indexer patterns transfer.

Per-trove events, all `_troveId`-indexed:

| Event                      | Carries                                                                                                                           | Emitted on                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `TroveUpdated`             | resulting debt, coll, stake, rate, redist snapshots                                                                               | every non-batched op; zeroed on close/liquidate |
| `TroveOperation`           | `Operation` enum, signed `_debtChangeFromOperation` / `_collChangeFromOperation`, redist increases, `_debtIncreaseFromUpfrontFee` | every op                                        |
| `BatchedTroveUpdated`      | batch shares (no debt, no rate), coll, stake                                                                                      | ops on batched troves                           |
| `RedemptionFeePaidToTrove` | `_ETHFee` = collateral fee credited to the trove                                                                                  | every redemption hit (0 for urgent)             |

Branch-level context events: `Redemption` (aggregate per
`CollateralRegistry.redeemCollateral*` call: attempted/actual amounts, coll
sent, fee, `_price`, `_redemptionPrice`), `Liquidation` (aggregate per
`batchLiquidateTroves` call: SP offset vs redistribution split, gas comp,
surplus, `_price`), `BatchUpdated`, `BaseRateUpdated`, `ShutDown`.

`Operation` ordinals: 0 openTrove, 1 closeTrove, 2 adjustTrove,
3 adjustTroveInterestRate, 4 applyPendingDebt, 5 liquidate,
6 redeemCollateral, 7 openTroveAndJoinBatch, 8 setInterestBatchManager,
9 removeFromBatch.

Semantics the page depends on:

- `TroveUpdated._debt` is the full resulting debt (accrued interest and redist
  gains are folded in on every touch; the open row includes the upfront fee).
- `TroveOperation._debtChangeFromOperation` is the user-requested principal
  change only. Resulting debt = previous recorded debt + accrued interest +
  `_debtIncreaseFromRedist` + `_debtIncreaseFromUpfrontFee` + the signed
  change. Accrued interest is the one term events never carry; it is the
  residual between consecutive snapshots. Any before/after pair derived from
  this arithmetic is therefore defined as **post-accrual**: `before` is the
  recorded debt with accrued interest already folded in, immediately before
  the operation's own change; subtracting the terms the events carry from
  `after` recovers exactly that value, never the pre-accrual figure.
- A redemption hit emits, per trove in one tx: `TroveUpdated` (or
  `BatchedTroveUpdated`) with the reduced totals, `TroveOperation(op=6,
−boldLot, −collLot)`, and `RedemptionFeePaidToTrove(fee)`. The fee stays in
  the trove as extra collateral — the owner is paid to be redeemed through.
  The Mento-only `redeemCollateralRebalancing` path (liquidity strategy only,
  fixed `_troveOwnerFee`, no `baseRate` impact) emits the same events; the
  discriminator is the transaction target, exactly as
  `docs/notes/liquity-monitoring-invariants.md` prescribes.
- Zombie transitions have no event. A redemption that leaves
  `0 < debt < MIN_DEBT` makes the trove a zombie; `debt == 0` leaves an
  open, fully-redeemed shell. Revival is `adjustZombieTrove` (surfaces as
  op 2) or `applyPendingDebt` (op 4). `MIN_DEBT` lives in the upgradeable
  `SystemParams` proxy with no change events — always read live per-market
  values, never constants. Live today: GBPm/CHFm minDebt 1,000; JPYm
  200,000; MCR 110%; CCR 135% — the deploy-script defaults (2,000 / 150%)
  are wrong for production.

What events alone cannot reconstruct (bounds for the design):

1. Debt between touches — compute client-side as
   `recordedDebt · rate · Δt / 365d` from the last row, or read
   `getLatestTroveData` over RPC for "now".
2. Price/ICR at arbitrary timestamps — `FXPriceFeed.fetchPrice()` emits
   nothing; only `Liquidation._price` and `Redemption._price` pin prices.
3. Batched trove debt (share math plus batch accrual) — precise values need
   `getLatestBatchData`.
4. Oracle-failure shutdown — `shutdownFromOracleFailure` skips the `ShutDown`
   event; the only signal is `FXPriceFeedShutdown`, and no FXPriceFeed
   contract is in the indexer config.
5. Trove ids are never reused after close
   (`BorrowerOperations.sol:1171-1176` requires `nonExistent`;
   `TroveManager.sol:1536` persists closed status), so one `Trove` entity is
   one lifecycle. The page can rely on this.

## Indexer today: what exists, what blocks the page

Already sufficient (no work needed):

- `Trove` entity: current state plus lifetime cumulatives
  (`redemptionCount`, `redeemedColl/Debt`, `redemptionFeePaidCum`,
  `liquidatedColl/Debt`, `collSurplus`, `priceAtLiquidation`, opened/closed
  timestamps and tx hashes). `owner` is indexed — owner lookup works today.
- `TroveOperationEvent`: append-only rows for user ops (0,1,2,3,7,8,9) with
  signed deltas, upfront fee, `owner` denormalized, and before/after
  snapshot fields.
- `RedemptionEvent.isRebalance` discrimination, market params in
  `LiquityCollateral`, rate ladder via `InterestRateBracket` and open troves.

Gaps (each maps to a design item below):

1. **No per-trove redemption rows.** `RedemptionEvent` is instance-level with
   no trove id, and one redemption provably splits across troves, so adding a
   nullable `troveId` to it cannot work. `RedemptionFeePaidToTrove` only
   bumps a cumulative. The per-hit data (debt repaid, coll taken, fee,
   resulting balances) arrives in handlers today and is discarded.
2. **`TroveOperationEvent` skips ops 4, 5, 6**
   (`troveOperationSnapshot.ts:75-80`) — the append-only log has holes
   exactly where support questions live: redemptions, liquidation, and the
   interest-fold/zombie-revival op.
3. **Snapshot before/after bug (live today).** `TroveUpdated` is emitted
   before `TroveOperation` in every TroveManager function (e.g. L1254 →
   L1264), so by the time the `TroveOperation` handler captures
   "pre-operation" state off the `Trove` entity, the `TroveUpdated` handler
   has already applied the post-op values. The capture comment in
   `troveOperationSnapshot.ts:6-10` assumes otherwise. Result: `debtBefore`
   holds the post-op value and `debtAfter` double-counts the delta
   (ticket trove's open row: `debtBefore` 25,012.87, `debtAfter` 50,025.75).
   The dashboard's existing before → after transaction cells render these
   wrong numbers now; the signed `collChange`/`debtChange` fields are
   correct. Fix is a capture-ordering change plus resync backfill,
   independent of this feature and worth shipping first.
4. **No price/ICR history.** `loadLiquityPrice` already `eth_call`s the price
   feed at every `TroveUpdated` block, uses it for `icrBps`, and discards it.
5. **No index on `TroveOperationEvent.troveId`** — a per-trove filter scans.
6. Status transitions (active → zombie → redeemed/revived) mutate `Trove` in
   place and leave no row. Indexer status vocabulary is
   `active/zombie/closed/liquidated/redeemed` (`troves.ts:16-22`);
   `redeemed` means fully-redeemed-to-zero, which stays `zombie` on-chain.
   The page uses indexer vocabulary and explains it.

## Indexer design

### New entity: `TroveLedgerEvent`

One append-only row per `TroveOperation` event, all ten ops, written in the
existing `TroveOperation` handler from data it already receives:

```graphql
type TroveLedgerEvent @index(fields: ["troveEntityId", "timestamp"]) {
  id: ID! # eventId(chainId, block, logIndex) — an UNPADDED string; never sort by it
  chainId: Int!
  instanceId: String! @index
  troveEntityId: String! # makeTroveId(collateralId, troveId)
  troveId: String!
  owner: String! @index
  operation: Int! # Operation ordinal 0-9
  collChange: BigInt! # signed, from operation
  debtChange: BigInt! # signed, from operation
  debtIncreaseFromUpfrontFee: BigInt!
  debtIncreaseFromRedist: BigInt!
  collIncreaseFromRedist: BigInt!
  annualInterestRate: BigInt!
  debtBefore: BigInt # post-accrual, pre-operation; null on batch-op rows until replay
  debtAfter: BigInt # null on batch-op rows until replay
  collBefore: BigInt!
  collAfter: BigInt!
  statusBefore: String!
  statusAfter: String! # surfaces zombie/redeemed/revival flips
  redemptionFeeCredited: BigInt # op 6 only, from RedemptionFeePaidToTrove
  isRebalance: Boolean # op 6 only, tx-target discriminator
  redemptionPrice: BigInt # op 6 only, from branch Redemption event
  priceAtEvent: BigInt # from loadLiquityPrice; null when unavailable
  icrAfterBps: Int # null when price unavailable
  timestamp: BigInt!
  blockNumber: BigInt!
  logIndex: Int! # numeric position for same-timestamp ordering
  txHash: String!
}
```

Why a new entity instead of widening `TroveOperationEvent`: the existing
entity feeds the market transaction tables, whose redemption and liquidation
rows come from the dedicated instance-level entities — adding op-5/6 rows to
it would double-render every redemption in those feeds and change the meaning
of an entity two tables already consume. A parallel entity keeps the rollout
introspection-gated and the existing feed untouched. The cost is one more
writer in a handler that already loads every input.

Writer notes:

- Capture `debtBefore/collBefore` correctly. The robust source is
  arithmetic, both here and in the fix for the existing snapshot bug: the
  paired `TroveUpdated`/`BatchedTroveUpdated` in the same tx gives the
  resulting state, and `after − (sum of the event-carried deltas) = before`, with
  accrued interest landing as an explicit residual term. Direction matters:
  derive `before` from `after`, never `after` from a pre-captured `before`.
  These snapshots are **post-accrual, pre-operation** (semantics section
  above): subtracting the event-carried terms recovers the debt with accrued interest
  already folded in, so the pair is self-consistent and the client-side
  interest residual falls between rows, never inside one. Tests must cover
  both zero elapsed interest (open, same-block ops) and non-zero elapsed
  interest (an op days after the last touch).
- `statusBefore` is NOT recoverable arithmetically: by the time
  `TroveOperation` is handled, the `TroveUpdated` handler has already
  classified and persisted the resulting status, and numeric deltas cannot
  distinguish active/zombie/redeemed or the pre-open placeholder. Capture
  the prior status into same-tx pending state in the
  `TroveUpdated`/`BatchedTroveUpdated` handler before it mutates the
  `Trove`, and let the ledger writer read it from there (the short-lived
  pending pattern the batch replay machinery already uses).
- Batch-op rows (ops 7-9 and in-batch adjusts/applies) cannot fill debt
  snapshots from this handler: `BatchedTroveUpdated` carries shares and
  collateral, and per-trove debt only becomes derivable when `BatchUpdated`
  is replayed. Write those rows with null `debtBefore/debtAfter` and patch
  them through the existing batch-replay path, or leave them null with the
  UI's "—" rendering — production has zero batches today, so the seam is
  cheap either way. Collateral snapshots stay non-null.
- Op 6 enrichment: `RedemptionFeePaidToTrove` follows `TroveOperation` in the
  same tx; carry the fee onto the ledger row (same short-lived pending
  pattern the batch replay machinery already uses). `isRebalance` copies the
  existing tx-target check; `redemptionPrice` copies from the branch
  `Redemption` row of the same tx.
- Op 5: `debtChange/collChange` are `−entireDebt/−entireColl`; link the
  aggregate `LiquidationEvent` by `txHash` for the SP/redistribution context
  panel. Per-trove split of that aggregate stays a non-goal.
- `priceAtEvent`/`icrAfterBps`: persist what `loadLiquityPrice` already
  fetches. Incremental cost for new events is zero; historical rows need a
  full resync that re-issues archive `eth_call`s from block 60,668,167 —
  forno was observed dropping log ranges and receipts during the ticket
  reconstruction, so treat backfill as a deliberate, monitored deploy
  (`deploy-indexer` skill), and let the fields stay null on old rows if the
  resync is deferred. Nullable-by-design is the degraded mode.
- Keep `applySystemDebtDelta` untouched; the new writer only appends rows.

### Small fixes alongside

- Fix `TroveOperationEvent.debtBefore/debtAfter/collBefore/collAfter`
  (gap 3) with the same arithmetic derivation, in its own slice with its own
  test proving the open row reads `before = 0`.
- Add `@index(fields: ["instanceId", "troveId", "timestamp"])` to
  `TroveOperationEvent` (gap 5) so the interim per-trove filter stops
  scanning. The raw `troveId` alone is NOT market-unique: it is
  `keccak(owner, ownerIndex)`, so the same owner and index produce the same
  id on every branch — every per-trove filter scopes by `instanceId` too.
- Index `Trove.previousOwner`: the NFT burn handler zeroes `owner` on close
  and liquidation and moves the last owner into `previousOwner`
  (`troveNFT.ts`), so an owner lookup over `owner` alone cannot find exactly
  the closed troves support asks about.

### Deferred, with seams

- `TroveOwnershipTransfer` rows from `TroveNFT.Transfer` (provenance).
- CollSurplusPool `CollBalanceUpdated`/`CollSent` indexing (claimable vs
  claimed surplus for liquidated troves).
- FXPriceFeed subscription for `FXPriceFeedShutdown` (shutdown banner: a shut
  branch stops accrual at `shutdownTime` and switches redemptions to urgent,
  fee 0).

## GraphQL contract

New queries in `ui-dashboard/src/lib/queries/liquity.ts`, registered in the
graphql contract test, regenerated via `pnpm indexer:codegen` and
`pnpm dashboard:codegen`:

- `CDP_TROVE_BY_ID(troveEntityId)` — one `Trove` row (header card), plus its
  `LiquityCollateral` params.
- `CDP_TROVE_LEDGER(troveEntityId, limit)` — `TroveLedgerEvent`
  `order_by: [{timestamp: desc}, {blockNumber: desc}, {logIndex: desc}]`,
  reversed client-side, so if a trove ever exceeds the 1,000-row Hasura cap
  the OLDEST rows drop, never the recent events being investigated. `id` is
  an unpadded string and never participates in ordering. Truncation is
  detected exactly, without aggregates (disabled on hosted Hasura): request
  `limit + 1` rows and render `limit`, keeping the render limit at least
  one below the 1,000-row Hasura hard cap (render 999, request 1,000) so
  the capped response can still carry the sentinel row. Disclose ("earliest
  history truncated") only when the sentinel came back — a history of
  exactly the render limit is complete and says nothing.
- `CDP_TROVES_BY_OWNER(address)` — `Trove` rows across markets matching
  `_or: [{owner}, {previousOwner}]`, for the support entry path: close and
  liquidation zero `owner`, so `previousOwner` is how a closed trove is
  found by the address a user supplies.
- Timing: dashboard codegen and the GraphQL contract test validate every
  exported query against the in-repo `indexer-envio/schema.graphql`, so
  `CDP_TROVE_LEDGER` can only be added once slice 2's schema change is
  merged — it is not an optional-query exclusion. The runtime introspection
  gate (the `CDP_TROVE_OP_SNAPSHOTS` pattern) covers the remaining window
  where the schema is merged but hosted Hasura has not yet promoted: the
  page detects `TroveLedgerEvent` in the live schema and falls back to the
  interim assembly (below) until it appears.

Interim assembly (works against today's schema, ships first): merge
`TroveOperationEvent` filtered by `instanceId` AND `troveId` (user ops; raw
`troveId` collides across markets) with `Trove` cumulatives
(redemption/liquidation lifetime totals). This is an explicitly **partial**
view and must say so: protocol rows (redemptions, liquidation, op 4) are
missing, so the interest-residual estimate, the debt/coll chart, the
net-equity figure, and the cumulatives-reconciliation check are all
suppressed — deriving any of them from user ops alone would misclassify
missing redemption deltas as interest. The partial view shows the header,
the raw lifetime totals, and the user-op list with a visible
"per-redemption detail pending indexer rollout" notice. It answers half the
ticket immediately and exercises the whole UI shell.

## UI design

### Route and entry points

`/cdps/[symbol]/troves/[troveId]`, `troveId` = the on-chain hex id (readable,
matches explorer links; resolve to `troveEntityId` internally via the
market's collateral id). Follow the `address-book/[address]` precedent:
server component validates params and redirects garbage to `/cdps/[symbol]`;
`error.tsx` with `useReportError`; `loading.tsx` skeleton matching the loaded
grid. The route is public, like the rest of `/cdps`.

Entry points:

1. Trove tables (`trove-cells.tsx`): the trove-id cell becomes an internal
   `<Link>` to the history page, on both Open and History tabs. The Mento-app
   manage link moves to a secondary action on the history page header
   ("Manage in app ↗") — the dashboard row's primary click should answer
   questions, and only the owner can manage.
2. Owner lookup for the support flow (address in hand, market unknown): the
   `/cdps` overview gets a small owner search that runs
   `CDP_TROVES_BY_OWNER` and links each hit. Phase 2; the per-market table
   search already matches owner today.
3. `AddressLink` stays as-is for owners (explorer, or address-book deep link
   when signed in).

Add the missing dependency-cruiser route-private rules: `/cdps` has none
today, so the new `troves/[troveId]/_components` rule lands with the page
(mirror `dashboard-route-private-pool-detail`).

### Layout

```text
┌──────────────────────────────────────────────────────────────────┐
│ GBPm · Trove 0x8abc…0d7d          [active] [Manage in app ↗]     │
│ Owner 0xcca0…d3bb   Opened 2026-08-06 (tx)   Rate 1.6% (#2 in    │
│ Coll 44,791 USDm    Debt 28,081 GBPm†   ICR 117.1% (MCR 110%)    │
│ † recorded at last event, 2026-08-26 10:38 UTC; interest accrues │
├──────────────────────────────────────────────────────────────────┤
│ Redemption impact              │ Why this trove                  │
│ 5 hits · −18,451 GBPm debt     │ Redemptions repay the lowest-   │
│ −25,164 USDm coll · +12.59     │ rate troves first. Current      │
│ USDm fees kept · net equity    │ rate 1.6% = rank #2 of 14;      │
│ +11 USDm at oracle prices      │ 6,200 GBPm of lower-rate debt   │
│ Exchanged at par — this is     │ shields this trove today.       │
│ a deleverage, not a loss.      │ (Historical rank: not tracked.) │
├──────────────────────────────────────────────────────────────────┤
│ Collateral & debt over time  [range pills]                       │
│ step chart: coll (USDm), debt (GBPm), event markers;             │
│ ICR series only where priceAtEvent exists                        │
├──────────────────────────────────────────────────────────────────┤
│ Ledger (chronological)                                           │
│ time·tx │ event badge │ Δdebt │ Δcoll │ fees │ debt→ │ coll→ │…  │
│ …rebalance-redemption rows, rate changes, interest rows…         │
└──────────────────────────────────────────────────────────────────┘
```

- **Header card** reads `CDP_TROVE_BY_ID`. Status badge uses indexer
  vocabulary with tooltips ("zombie: debt below the market minimum after a
  redemption; unredeemable until adjusted"; "redeemed: fully redeemed to
  zero"). ICR coloring reuses `icrTextClass` against live `mcrBps`. The debt
  figure is honest about staleness: recorded-at-last-event plus timestamp. A
  live `entireDebt` read via the existing `rpc-client.ts` is an optional
  enhancement, decided at implementation (open question 1).
- **Redemption impact** computes its totals from `Trove` cumulatives, so
  they work even before the ledger entity ships. Split user vs rebalance
  per the invariants note once per-hit rows exist; until then label totals
  as totals. The net-equity line requires per-hit `redemptionPrice` — a
  trove redeemed at different FX prices cannot be valued from lifetime
  sums, and pricing it at the current rate would fabricate the core support
  answer — so it renders only from complete ledger rows and is absent in
  the partial view. The one-line explainer carries the ticket's core
  lesson.
- **Why me** reads the current rate ladder (open troves / brackets already
  fetched on the market page): rank among open troves by effective rate, and
  the sum of open debt at strictly lower rates ("shield"). States plainly
  that historical rank is not tracked.
- **Chart**: two stacked single-unit panels — collateral (USDm) and debt
  (debt-token units) — never one dual-axis plot, with series built from
  ledger `collAfter`/`debtAfter` (step interpolation), `sortedCopy` for
  ordering, `escapePlotText` on any dynamic text. `TimeSeriesChartCard`
  exposes one y-axis and hardcodes dollar-prefixed hover formatting
  (`time-series-chart-card.tsx:283-323`), which would label GBPm/JPYm debt
  as dollars — either extend it with per-series unit formatting and
  subplot support or build a sibling two-panel chart component on the same
  chrome. The chart reads the same bounded full-history query as the table
  — one query, no pagination coupling — and renders only from the complete
  ledger, never the partial view.
- **Ledger table**: badge pills reuse `BADGE_STYLES`/`BADGE_LABELS` plus new
  kinds (`rebalanceRedemption` already exists; add `zombie`, `revived`,
  `interest`). Signed deltas use `formatSignedWei`; unsigned totals use
  `formatTokenAmount` — per-field semantics, exactly as the invariants note
  requires. Synthetic, clearly-marked "interest accrued ≈ +X" rows render
  the residual between consecutive rows' recorded debt after subtracting the
  event-carried terms; they are derived client-side, labeled as estimates,
  excluded from sums, and rendered only in complete-ledger mode (the
  partial view suppresses them). Status flips render from
  `statusBefore`/`statusAfter`. Default order chronological ascending with
  the `blockNumber`, `logIndex` tiebreakers, newest visible via reverse
  toggle; local-only state (intentional scope: single bounded dataset, no
  URL pagination).

### Invariants (stateful-data-ui checklist, defined up front)

1. Every ledger row persists `txHash`, `blockNumber`, `logIndex`,
   `timestamp`, and a unique `id`; ordering is deterministic on the numeric
   triple (`timestamp`, `blockNumber`, `logIndex`). The unpadded string
   `id` never participates in ordering (`_10` sorts before `_2`).
2. The ledger is append-only; the `Trove` entity remains the only mutable
   trove state. In complete-ledger mode, cumulatives shown on the page must
   equal the sum of ledger rows of the matching kind — a mismatch is a bug
   surface, not a rendering choice (the ticket reconstruction validated to
   the wei; keep a test). The partial view skips this check by design.
3. Total redemption figures are never presented as user activity;
   user-driven = total − rebalance.
4. `priceAtEvent`/`icrAfterBps` are nullable; every consumer renders null as
   "—", never as zero.
5. Charts read the full bounded history query, never a paginated slice.
6. Params (`minDebt`, MCR, CCR) come from `LiquityCollateral` rows, never
   constants.

### Degraded modes

- `TroveLedgerEvent` absent from schema (pre-rollout, or rollback): the
  partial view — header, raw cumulative totals, user-ops-only list, visible
  "protocol events pending" notice; interest estimates, the chart, net
  equity, and reconciliation stay off. No silent gaps.
- Ledger query fails with header loaded: cards render, table shows the error
  state with retry; distinct loading vs empty vs error per `swr-state`
  helpers.
- Unknown trove id: explicit "not indexed" state with an explorer address
  link fallback, no redirect loop.
- Old rows without price fields: chart drops the ICR series and says so.
- History at the row cap: newest rows are kept (desc fetch, reversed
  client-side) and the page discloses "earliest history truncated" (cap
  detected by the `limit + 1` sentinel row, never by `length === limit`
  alone; the render limit sits below the Hasura hard cap so the sentinel
  request is never itself capped).

### Tests

- Indexer: handler tests proving open rows read `before = 0`, snapshots are
  correct with both zero and non-zero elapsed interest since the last touch,
  redemption rows carry fee/isRebalance/price, status flips produce correct
  before/after (including the pending-state capture across the
  `TroveUpdated` → `TroveOperation` ordering), and the split-redemption case
  (one instance redemption, two troves) yields two rows whose sums match the
  branch event.
- Dashboard: colocated unit tests for ledger merge/derivation (interest
  residual, badge mapping, formatter choice), the three degraded modes, and
  entry-link resolution. Fixture-server browser scenario for the route;
  visual-snapshot baseline optional (no `/cdps` baseline exists today —
  parity, not regression).

## How the finished page answers ticket #0754

Support pastes the owner address → owner lookup → one GBPm trove → header
shows active, 44,791 USDm / 28,081 GBPm, ICR 117.1%. The impact card reads
"5 redemption hits on 2026-08-25: −18,451 GBPm debt, −25,164 USDm collateral,
+12.59 USDm fees kept, net equity +11 USDm — exchanged at oracle par." The
chart shows the cliff at 18:13 UTC and the rebuild next morning. The ledger
lists the five rebalance-redemption rows with tx links and the user's three
follow-up ops. The why-me panel explains the 0.5% rate sat at the front of
the redemption queue. Total time: one page view.

## Rollout

Sequenced per `docs/pr-checklists/stateful-data-ui.md`; each slice is one PR
through the quality gate, with `pnpm indexer:codegen` /
`pnpm dashboard:codegen` where schema or queries change, and the indexer
slices deployed via the `deploy-indexer` skill (envio branch → verify sync →
promote):

1. **Fix the existing snapshot bug** (indexer) — independent, user-visible
   today in the market transaction tables. Requires resync to repair
   historical rows; the deploy is the backfill.
2. **`TroveLedgerEvent` + indexes** (indexer) — new entity, writers, tests;
   decide at implementation whether the price backfill resync rides along or
   old rows stay null. If the entity-vs-widening choice is judged to
   constrain future work, record the ADR in this PR.
3. **Trove history page** (dashboard) — route, header/cards/chart/ledger,
   introspection-gated ledger query with the interim assembly fallback,
   dependency-cruiser rules, tests, browser verification per
   `docs/notes/dashboard-verification.md`.
4. **Entry points** (dashboard) — trove-table links, owner lookup on
   `/cdps`, docs/index updates.

Slices 3 and 4 can ship before 2 completes, but only with the interim
queries: `CDP_TROVE_LEDGER` cannot be added until slice 2's schema change is
merged, because dashboard codegen and the contract test validate against the
in-repo `schema.graphql`. Once both are in, the runtime introspection gate
covers the deploy window and the page upgrades itself when hosted Hasura
serves the new entity.

## Open questions

1. Live `entireDebt`/ICR on the header via `rpc-client.ts`, or
   indexed-recorded values only with an honest timestamp? (Recommend
   indexed-only v1; RPC read as a follow-up if support asks for to-the-second
   numbers.)
2. Is the price/ICR backfill worth a monitored full resync now, or do old
   ledger rows stay price-less until the next scheduled resync? (Recommend
   defer; the ticket-class questions don't need historical ICR.)
3. Owner lookup placement: `/cdps` overview search vs a dedicated
   `/cdps/troves?owner=` route. (Recommend overview search; one less route.)
4. Should the history tab's closed troves link through to the page from day
   one? (Recommend yes; closed troves are where support questions end up.)
