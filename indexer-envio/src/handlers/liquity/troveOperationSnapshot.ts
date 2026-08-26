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

/** Recover the trove's debt/coll immediately BEFORE this `TroveOperation`
 *  applied, given the already-correct AFTER values and every signed/
 *  unsigned delta the ABI exposes:
 *
 *    debtBefore = debtAfter − debtChange − upfrontFee − debtFromRedist
 *    collBefore = collAfter − collChange − collFromRedist
 *
 *  Direction matters: `after` comes from the entity (true post-operation
 *  state, since `TroveUpdated` ran first — see `captureTroveOperationSnapshotState`),
 *  and `before` is always derived FROM `after`, never the reverse. Floors
 *  at zero defensively, matching the on-chain invariant that a trove's
 *  debt/coll cannot go negative; only a future ABI revision or an
 *  unexpected event sequence could otherwise underflow the signed bigint
 *  arithmetic here. */
function deriveTroveOperationBeforeSnapshot(params: {
  debtAfter: bigint;
  collAfter: bigint;
  debtChange: bigint;
  debtIncreaseFromUpfrontFee: bigint;
  debtIncreaseFromRedist: bigint;
  collChange: bigint;
  collIncreaseFromRedist: bigint;
}): { debtBefore: bigint; collBefore: bigint } {
  const debtBefore =
    params.debtAfter -
    params.debtChange -
    params.debtIncreaseFromUpfrontFee -
    params.debtIncreaseFromRedist;
  const collBefore =
    params.collAfter - params.collChange - params.collIncreaseFromRedist;
  return {
    debtBefore: debtBefore > 0n ? debtBefore : 0n,
    collBefore: collBefore > 0n ? collBefore : 0n,
  };
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
 *  `debtAfter` / `collAfter` come from the trove entity (captured in the
 *  parent handler, already correct — see `captureTroveOperationSnapshotState`);
 *  `debtBefore` / `collBefore` are derived arithmetically from the ABI
 *  deltas via `deriveTroveOperationBeforeSnapshot`, never from a second
 *  entity read. The `owner` field is denormalized off the trove so the UI
 *  can filter by owner without a join. */
export function maybeRecordTroveOperation(args: {
  context: {
    TroveOperationEvent: { set: (entity: TroveOperationEvent) => void };
  };
  op: number;
  event: TroveOperationLogEvent;
  instanceId: string;
  troveId: string;
  snapshotState: { owner: string; debtAfter: bigint; collAfter: bigint };
  blockNumber: bigint;
  blockTimestamp: bigint;
}): void {
  const { context, op, event, instanceId, troveId, snapshotState } = args;
  if (
    op === OP.LIQUIDATE ||
    op === OP.REDEEM_COLLATERAL ||
    op === OP.APPLY_PENDING_DEBT
  )
    return;
  const { owner, debtAfter, collAfter } = snapshotState;
  const { debtBefore, collBefore } = deriveTroveOperationBeforeSnapshot({
    debtAfter,
    collAfter,
    debtChange: event.params._debtChangeFromOperation,
    debtIncreaseFromUpfrontFee: event.params._debtIncreaseFromUpfrontFee,
    debtIncreaseFromRedist: event.params._debtIncreaseFromRedist,
    collChange: event.params._collChangeFromOperation,
    collIncreaseFromRedist: event.params._collIncreaseFromRedist,
  });
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
