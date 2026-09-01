import type { Trove, TroveOperationEvent } from "envio";
import { asAddress, eventId } from "../../helpers.js";
import { OP } from "./operations.js";

/** Capture the trove fields needed for a TroveOperationEvent snapshot
 *  before any handler branch in the parent TroveOperation handler mutates
 *  the entity further.
 *
 *  These are NOT pre-operation values: on-chain, every TroveManager
 *  function emits `TroveUpdated` before `TroveOperation` for the same op,
 *  so by the time Envio's ordered event processing reaches this handler,
 *  the `TroveUpdated` handler has already applied the post-operation
 *  debt/coll to the `Trove` entity. `trove.debt`/`trove.coll` here are the
 *  AFTER snapshot; the BEFORE snapshot is derived arithmetically in
 *  `maybeRecordTroveOperation` from the event's own delta fields, never
 *  from a second read of the (already-mutated) entity.
 *
 *  OPEN_TROVE owner race: on-chain log order is TroveNFT.Transfer (mint)
 *  → TroveOperation, so under normal Envio ordering `trove.owner` is
 *  already populated by the time we read it here. If the placeholder
 *  fallback in `getOrCreateTrove` ever fires for an OPEN_TROVE (i.e.
 *  TroveOperation observed before the matching Transfer mint), this row
 *  gets `owner: ZERO_ADDRESS` and a later Transfer update to
 *  `Trove.owner` does NOT propagate back to this TroveOperationEvent.
 *  Affects only the very first row of a freshly-opened trove; all
 *  subsequent ops on the same trove capture the real owner. Accepted as
 *  a soft degradation rather than patching from the Transfer handler
 *  (which would cost an extra getWhere on every mint). */
export function captureTroveOperationSnapshotState(trove: Trove): {
  owner: string;
  debtAfter: bigint;
  collAfter: bigint;
} {
  return {
    owner: trove.owner,
    debtAfter: trove.debt,
    collAfter: trove.coll,
  };
}

/** Recover the trove's collateral immediately BEFORE this `TroveOperation`
 *  applied, given the already-correct AFTER value and the signed/unsigned
 *  coll deltas the ABI exposes:
 *
 *    collBefore = collAfter − collChange − collFromRedist
 *
 *  Direction matters: `after` is always the true post-operation state (see
 *  `maybeRecordTroveOperation` for where it comes from on batch-managed vs.
 *  ordinary troves), and `before` is always derived FROM `after`, never the
 *  reverse. Floors at zero defensively, matching the on-chain invariant that
 *  a trove's coll cannot go negative; only a future ABI revision or an
 *  unexpected event sequence could otherwise underflow the signed bigint
 *  arithmetic here. */
function deriveCollBefore(params: {
  collAfter: bigint;
  collChange: bigint;
  collIncreaseFromRedist: bigint;
}): bigint {
  const collBefore =
    params.collAfter - params.collChange - params.collIncreaseFromRedist;
  return collBefore > 0n ? collBefore : 0n;
}

/** Same derivation as `deriveCollBefore`, for debt:
 *
 *    debtBefore = debtAfter − debtChange − upfrontFee − debtFromRedist
 *
 *  Only valid when `debtAfter` is the trove's true post-operation debt —
 *  never call this for a batch-managed-trove row (see
 *  `maybeRecordTroveOperation`). */
function deriveDebtBefore(params: {
  debtAfter: bigint;
  debtChange: bigint;
  debtIncreaseFromUpfrontFee: bigint;
  debtIncreaseFromRedist: bigint;
}): bigint {
  const debtBefore =
    params.debtAfter -
    params.debtChange -
    params.debtIncreaseFromUpfrontFee -
    params.debtIncreaseFromRedist;
  return debtBefore > 0n ? debtBefore : 0n;
}

export type TroveOperationLogEvent = {
  chainId: number;
  block: { number: number };
  logIndex: number;
  transaction: { hash: string };
  params: {
    _collChangeFromOperation: bigint;
    _debtChangeFromOperation: bigint;
    _annualInterestRate: bigint;
    _debtIncreaseFromUpfrontFee: bigint;
    _debtIncreaseFromRedist: bigint;
    _collIncreaseFromRedist: bigint;
  };
};

/** Persist a TroveOperationEvent row for user-initiated ops so the UI can
 *  render opens / closes / adjusts / interest-rate changes / batch-
 *  membership moves alongside liquidations + redemptions in a unified
 *  transactions feed. LIQUIDATE and REDEEM_COLLATERAL are skipped because
 *  they already have dedicated event entities; APPLY_PENDING_DEBT is
 *  protocol-forced and isn't a user action.
 *
 *  `debtAfter` / `collAfter` normally come from the trove entity (captured
 *  in the parent handler, already correct — see
 *  `captureTroveOperationSnapshotState`); `debtBefore` / `collBefore` are
 *  derived arithmetically from the ABI deltas, never from a second entity
 *  read.
 *
 *  Batch-managed exception: for ops 7-9 and any ordinary adjustment made
 *  while the trove is batch-managed, on-chain `BatchedTroveUpdated` fires
 *  instead of `TroveUpdated` — so by the time this handler runs, the `Trove`
 *  entity still holds this op's PRIOR debt/coll (`replayBatchedTroveUpdate`
 *  only writes the real post-op values once the later `BatchUpdated` event
 *  is processed). `pendingBatchedTroveUpdate` is the same-tx
 *  `PendingBatchedTroveUpdate` row `BatchedTroveUpdated` staged before this
 *  handler ran (it fires first — same ordering guarantee as `TroveUpdated`);
 *  its presence is the discriminator. It carries the real resulting
 *  collateral directly (not share-based), so `collAfter` is sourced from it
 *  and `collBefore` derives correctly. It carries only debt SHARES — the
 *  per-trove debt figure needs the batch's total debt and total shares,
 *  known only at `BatchUpdated` time — so `debtBefore`/`debtAfter` are
 *  recorded null rather than a confidently wrong number. Production has zero
 *  batches today; the seam is cheap either way.
 *
 *  The `owner` field is denormalized off the trove so the UI can filter by
 *  owner without a join. */
export function maybeRecordTroveOperation(args: {
  context: {
    TroveOperationEvent: { set: (entity: TroveOperationEvent) => void };
  };
  op: number;
  event: TroveOperationLogEvent;
  instanceId: string;
  troveId: string;
  snapshotState: { owner: string; debtAfter: bigint; collAfter: bigint };
  pendingBatchedTroveUpdate: { coll: bigint } | undefined;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): void {
  const {
    context,
    op,
    event,
    instanceId,
    troveId,
    snapshotState,
    pendingBatchedTroveUpdate,
  } = args;
  if (
    op === OP.LIQUIDATE ||
    op === OP.REDEEM_COLLATERAL ||
    op === OP.APPLY_PENDING_DEBT
  )
    return;
  const { owner } = snapshotState;
  const collAfter = pendingBatchedTroveUpdate?.coll ?? snapshotState.collAfter;
  const collBefore = deriveCollBefore({
    collAfter,
    collChange: event.params._collChangeFromOperation,
    collIncreaseFromRedist: event.params._collIncreaseFromRedist,
  });
  const debtAfter =
    pendingBatchedTroveUpdate === undefined
      ? snapshotState.debtAfter
      : undefined;
  const debtBefore =
    pendingBatchedTroveUpdate === undefined
      ? deriveDebtBefore({
          debtAfter: snapshotState.debtAfter,
          debtChange: event.params._debtChangeFromOperation,
          debtIncreaseFromUpfrontFee: event.params._debtIncreaseFromUpfrontFee,
          debtIncreaseFromRedist: event.params._debtIncreaseFromRedist,
        })
      : undefined;
  context.TroveOperationEvent.set({
    id: eventId(event.chainId, event.block.number, event.logIndex),
    chainId: event.chainId,
    instanceId,
    troveId,
    owner: asAddress(owner),
    operation: op,
    collChange: event.params._collChangeFromOperation,
    debtChange: event.params._debtChangeFromOperation,
    debtBefore,
    debtAfter,
    collBefore,
    collAfter,
    annualInterestRate: event.params._annualInterestRate,
    debtIncreaseFromUpfrontFee: event.params._debtIncreaseFromUpfrontFee,
    timestamp: args.blockTimestamp,
    blockNumber: args.blockNumber,
    txHash: event.transaction.hash,
  });
}
