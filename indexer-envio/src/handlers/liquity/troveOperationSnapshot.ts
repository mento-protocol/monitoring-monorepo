import type { Trove, TroveOperationEvent } from "envio";
import { asAddress, eventId } from "../../helpers.js";
import { computeTroveOperationSnapshot } from "./math.js";
import { OP } from "./operations.js";

/** Capture the trove fields needed for a TroveOperationEvent snapshot
 *  before any handler branch mutates the entity. The 5 user-initiated
 *  ops we persist don't touch debt/coll in the TroveOperation handler
 *  (those land in TroveUpdated / BatchUpdated), so reading directly off
 *  the entity here yields the true pre-operation values.
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
  prevDebt: bigint;
  prevColl: bigint;
} {
  return {
    owner: trove.owner,
    prevDebt: trove.debt,
    prevColl: trove.coll,
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
 *  `debtBefore` / `collBefore` come from the trove entity (captured before
 *  any mutation in the parent handler); `debtAfter` / `collAfter` are
 *  computed arithmetically from the ABI deltas via
 *  `computeTroveOperationSnapshot`. The `owner` field is denormalized off
 *  the trove so the UI can filter by owner without a join. */
export function maybeRecordTroveOperation(args: {
  context: {
    TroveOperationEvent: { set: (entity: TroveOperationEvent) => void };
  };
  op: number;
  event: TroveOperationLogEvent;
  instanceId: string;
  troveId: string;
  snapshotState: { owner: string; prevDebt: bigint; prevColl: bigint };
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
  const { owner, prevDebt, prevColl } = snapshotState;
  const { debtAfter, collAfter } = computeTroveOperationSnapshot({
    debtBefore: prevDebt,
    collBefore: prevColl,
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
    debtBefore: prevDebt,
    debtAfter,
    collBefore: prevColl,
    collAfter,
    annualInterestRate: event.params._annualInterestRate,
    debtIncreaseFromUpfrontFee: event.params._debtIncreaseFromUpfrontFee,
    timestamp: args.blockTimestamp,
    blockNumber: args.blockNumber,
    txHash: event.transaction.hash,
  });
}
