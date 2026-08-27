---
title: TroveLedgerEvent is a parallel append-only entity, not a widened TroveOperationEvent
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
scope: indexer-envio (constrains ui-dashboard trove-history reads)
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0074 — TroveLedgerEvent is a parallel append-only entity, not a widened TroveOperationEvent

**Status:** Accepted (Aug 2026), in force.
**Scope:** indexer-envio (constrains ui-dashboard trove-history reads)

## Context

The trove history page (epic #2089, design in
`docs/PLAN-trove-history-page.md`) needs one append-only row per
trove-changing operation — all ten `Operation` ordinals, redemptions,
liquidations, and interest folds included — with pre/post snapshots. The
existing `TroveOperationEvent` deliberately skips ops 4, 5, and 6 because the
market transaction tables it feeds render redemptions and liquidations from
the dedicated instance-level entities; adding those rows to it would
double-render every redemption in feeds two tables already consume and change
the meaning of an entity in production use.

## Decision

- Record the full per-trove history in a new `TroveLedgerEvent` entity, one
  row per `TroveOperation` event across all ten ordinals.
  `TroveOperationEvent` stays user-ops-only and keeps its consumers
  untouched; the rollout stays introspection-gated on the new entity's
  presence in the served schema.
- The ledger is append-only. Each row is assembled from its own
  transaction's events and never mutated after that transaction is
  processed. Rows that need a later same-transaction event are staged in
  `PendingTroveLedgerEvent` and written exactly once by that finalizer: the
  branch `Redemption` handler (op 6 — the only carrier of
  `_redemptionPrice`, plus fee and the tx-target `isRebalance`
  discriminator), the aggregate `Liquidation` handler (op 5), or the
  `BatchUpdated` replay (batch rows). Never set-then-patch.
- Snapshots are post-accrual, pre-operation, derived `before = after − the
event-carried deltas` from the same-transaction resulting state — never
  `after` from a pre-captured `before`. `statusBefore` is captured into
  same-transaction pending state (`PendingTroveStatusCapture`) by the
  `TroveUpdated`/`BatchedTroveUpdated` handler before it mutates, because
  the update event precedes `TroveOperation` on-chain.
- Batch rows keep `debtBefore` null permanently (per-trove pre-operation
  debt inside a batch is not derivable from events, and the trove's stale
  recorded debt is pre-accrual); the `BatchUpdated` replay fills
  `debtAfter` (share math) and `statusAfter` (replayed classification)
  once at finalize. Op-5/6 rows on batched troves finalize in their own
  aggregate handlers, which fire after every per-trove event in the
  transaction — the replay included — so they take `statusAfter` and the
  missing `debtAfter` from the `Trove` entity's replayed state rather
  than the staged pre-replay classification.
- `REMOVE_FROM_BATCH` (op 9) is excluded from batch classification: its
  paired update is an ordinary `TroveUpdated` carrying the trove's full
  individual debt and collateral, so its row writes directly with
  complete snapshots. Its exit `BatchUpdated` replays no trove rows, so
  a staged batch row would never finalize.
- `priceAtEvent` persists the block-close `loadLiquityPrice` sample only
  for rows at or after a fixed calendar cutoff (2026-08-26T00:00:00Z, the
  design-approval date); replayed history keeps it null, so a re-sync is
  deterministic and spends no archive eth_calls on per-row prices.
  Event-carried prices win for `icrAfterBps` and never overwrite
  `priceAtEvent`.
- Every ledger write stamps `Trove.lastLedgerBlock`/`lastLedgerLogIndex`,
  the reconciliation watermark consumers must check before comparing
  cumulatives against ledger sums (`lastUpdatedBlock` advances on NFT
  transfers that write no ledger row, and block number alone cannot split
  two same-block transactions).

## Alternatives considered

- **Widen `TroveOperationEvent` to all ten ops** — rejected: the market
  transaction tables would double-render redemptions and liquidations, and
  the change would silently alter an entity two production tables consume.
  A parallel entity keeps the existing feed untouched at the cost of one
  more writer in a handler that already loads every input.
- **Write op-5/6 rows immediately and patch price/fee later** — rejected:
  set-then-patch breaks the append-only contract and risks serving
  half-written rows; staging in pending state keeps one complete write.
- **Wall-clock "near head" test for price persistence** — rejected: it
  makes replays non-deterministic; the fixed cutoff yields identical rows
  on every re-sync.

## Consequences

- The dashboard's full-ledger view (epic #2089 M4) reads
  `TroveLedgerEvent` ordered by the numeric triple (`timestamp`,
  `blockNumber`, `logIndex`); the unpadded string `id` never participates
  in ordering.
- Historical rows have null `priceAtEvent`/`icrAfterBps` except where an
  event carried a price; consumers must render null as "—", never zero.
- A future batch deployment gets correct-but-partial batch rows (null
  `debtBefore`) without any indexer change; filling them would need a new
  decision.
- The from-scratch deploy sync is the backfill; promotion follows the
  `deploy-indexer` skill gates.

## Evidence

- Issue #2082 (epic #2089); design doc `docs/PLAN-trove-history-page.md`
  ("Indexer design", "On-chain event surface", "Invariants"), merged via
  PR #2077.
- Writers: `indexer-envio/src/handlers/liquity/troveLedger.ts`,
  `troveManager.ts`, `batchReplay.ts`; schema entities `TroveLedgerEvent`,
  `PendingTroveLedgerEvent`, `PendingTroveStatusCapture` in
  `indexer-envio/schema.graphql`.
- Harness-driven mockDb coverage in
  `indexer-envio/test/liquityTroveLedger.test.ts` (all ten-ordinal paths:
  open/adjust/close, op-4 fold, single and split redemptions, liquidation,
  batch rows, zombie transition/revival, watermark, replay-null vs live
  price, event-price-wins ICR).
