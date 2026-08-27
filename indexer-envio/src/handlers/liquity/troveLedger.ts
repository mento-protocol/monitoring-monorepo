import type {
  PendingTroveLedgerEvent,
  PendingTroveStatusCapture,
  Trove,
  TroveLedgerEvent,
} from "envio";
import { asAddress, eventId } from "../../helpers.js";
import { pendingTroveKey } from "./keys.js";
import { computeTroveIcrBps } from "./math.js";
import { OP, isBatchMembershipOperation } from "./operations.js";
import type { TroveOperationLogEvent } from "./troveOperationSnapshot.js";

/** Writers for the append-only `TroveLedgerEvent` history (ADR 0074): one row
 * per `TroveOperation` event across ALL ten Operation ordinals. Rows that need
 * data from a later same-transaction event are staged in
 * `PendingTroveLedgerEvent` and written exactly once by their finalizer — the
 * branch `Redemption` handler (op 6, the only carrier of `_redemptionPrice`),
 * the aggregate `Liquidation` handler (op 5), or the `BatchUpdated` replay
 * (batch rows) — never set-then-patched. */

export const TROVE_LEDGER_KIND = {
  REDEMPTION: "redemption",
  LIQUIDATION: "liquidation",
  BATCH: "batch",
} as const;

/** Historical-replay cutoff for per-row price persistence, decided at design
 * approval (docs/PLAN-trove-history-page.md): rows before this timestamp are
 * replayed history and keep `priceAtEvent` null — the ledger spends no
 * archive eth_calls on per-row prices. Rows at or after it persist the
 * block-close sample. A fixed calendar cutoff (2026-08-26T00:00:00Z, the
 * design-approval date) keeps a future re-sync deterministic: the same event
 * always yields the same row, unlike a wall-clock "near head" test. */
export const TROVE_LEDGER_PRICE_CUTOFF_TIMESTAMP = 1_787_702_400n;

export const shouldPersistLedgerPrice = (blockTimestamp: bigint): boolean =>
  blockTimestamp >= TROVE_LEDGER_PRICE_CUTOFF_TIMESTAMP;

const floorZero = (value: bigint): bigint => (value > 0n ? value : 0n);

/** `icrAfterBps` from the winning price: event-carried where one exists
 * (op 5/6), else the block-close `priceAtEvent`. Undefined when the debt
 * snapshot is null (batch rows pre-replay), the price is unavailable, or the
 * ratio is undefined (zero debt after close/liquidation/full redemption). */
const toLedgerIcrBps = (
  coll: bigint,
  debt: bigint | undefined,
  price: bigint | null | undefined,
): number | undefined => {
  if (debt === undefined || price === null || price === undefined) {
    return undefined;
  }
  const icrBps = computeTroveIcrBps({ coll, debt, price });
  return icrBps < 0 ? undefined : icrBps;
};

/** Capture the trove's status before the paired `TroveUpdated` /
 * `BatchedTroveUpdated` handler mutates (or stages) state. On-chain the
 * update event precedes `TroveOperation` for non-batch ops, so by the time
 * the ledger writer runs, the entity already holds post-operation values —
 * `statusBefore` is not recoverable arithmetically. The ledger writer
 * consumes (deletes) the row. */
export function capturePendingTroveStatus(
  context: {
    PendingTroveStatusCapture: {
      set: (entity: PendingTroveStatusCapture) => void;
    };
  },
  args: {
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    statusBefore: string;
    batched: boolean;
    timestamp: bigint;
    blockNumber: bigint;
  },
): void {
  context.PendingTroveStatusCapture.set({
    id: pendingTroveKey(
      args.chainId,
      args.txHash,
      args.collateralId,
      args.troveId,
    ),
    collateralId: args.collateralId,
    txHash: args.txHash,
    troveId: args.troveId,
    statusBefore: args.statusBefore,
    batched: args.batched,
    timestamp: args.timestamp,
    blockNumber: args.blockNumber,
  });
}

/** Trove entity facts captured at TroveOperation-handler entry, before any of
 * that handler's own branch mutations. */
export type TroveLedgerEntryState = {
  owner: string;
  status: string;
  debt: bigint;
  coll: bigint;
  interestBatchId: string | undefined;
};

export type TroveLedgerWriteContext = {
  TroveLedgerEvent: { set: (entity: TroveLedgerEvent) => void };
  PendingTroveLedgerEvent: {
    set: (entity: PendingTroveLedgerEvent) => void;
  };
  PendingTroveStatusCapture: {
    get: (id: string) => Promise<PendingTroveStatusCapture | undefined>;
    deleteUnsafe: (id: string) => void;
  };
};

/** Write (or stage) the ledger row for one `TroveOperation` event.
 *
 * Snapshot derivation is post-accrual, pre-operation. Direction matters:
 * when the paired `TroveUpdated` already persisted the resulting state
 * (the normal non-batch ordering), `before` is derived from `after` minus
 * the event-carried deltas — accrued interest is the one term events never
 * carry, and this direction folds it into `debtBefore` so the interest
 * residual falls between rows, never inside one.
 *
 * Batch rows (a `BatchedTroveUpdated` sibling, a trove already in a batch,
 * or a batch-membership op whose `TroveOperation` precedes its update
 * event) carry null debt snapshots: per-trove debt truth is batch-level
 * until the `BatchUpdated` replay. Collateral snapshots stay non-null.
 * `REMOVE_FROM_BATCH` is the exception: its paired update is an ordinary
 * `TroveUpdated` carrying the trove's full individual debt, so its row
 * writes directly with complete snapshots.
 *
 * Ops 5/6 and batch rows are staged for their same-transaction finalizer;
 * everything else is written here. Returns the trove with the ledger
 * watermark stamped when a row was written directly, unchanged otherwise
 * (staged rows stamp the watermark at finalize time).
 */
export async function recordTroveLedgerOnOperation(
  context: TroveLedgerWriteContext,
  args: {
    op: number;
    collateralId: string;
    instanceId: string;
    /** Post-branch entity; the TroveOperation handler never mutates
     * debt/coll itself, so entryState carries the snapshot inputs. */
    trove: Trove;
    entryState: TroveLedgerEntryState;
    event: TroveOperationLogEvent;
    blockNumber: bigint;
    blockTimestamp: bigint;
    /** Block-close price for direct rows; null when unavailable or when
     * price persistence is suppressed (historical replay). */
    price: bigint | null;
  },
): Promise<Trove> {
  const { op, trove, entryState, event } = args;
  const pendingId = pendingTroveKey(
    event.chainId,
    event.transaction.hash,
    args.collateralId,
    trove.troveId,
  );
  const capture = await context.PendingTroveStatusCapture.get(pendingId);
  if (capture !== undefined) {
    context.PendingTroveStatusCapture.deleteUnsafe(pendingId);
  }
  // REMOVE_FROM_BATCH pairs with an ordinary `TroveUpdated` (the trove is
  // individual again — see the `onRemoveFromBatch` emit site), so the
  // entity already holds post-operation debt/coll and the row writes
  // directly. Its exit `BatchUpdated` replays no trove rows, so a staged
  // batch row would never finalize; the stale `interestBatchId` still on
  // the entry state (cleared only at batch replay) must not stage one.
  const batched =
    op !== OP.REMOVE_FROM_BATCH &&
    (capture?.batched === true ||
      entryState.interestBatchId !== undefined ||
      (capture === undefined && isBatchMembershipOperation(op)));
  const debtDelta =
    event.params._debtChangeFromOperation +
    event.params._debtIncreaseFromUpfrontFee +
    event.params._debtIncreaseFromRedist;
  const collDelta =
    event.params._collChangeFromOperation +
    event.params._collIncreaseFromRedist;
  let debtBefore: bigint | undefined;
  let debtAfter: bigint | undefined;
  let collBefore: bigint;
  let collAfter: bigint;
  if (batched) {
    collBefore = entryState.coll;
    collAfter = floorZero(entryState.coll + collDelta);
  } else if (capture !== undefined) {
    // The paired TroveUpdated persisted the resulting state before this
    // handler ran, so the entry values ARE the post-operation state.
    debtAfter = entryState.debt;
    collAfter = entryState.coll;
    debtBefore = floorZero(entryState.debt - debtDelta);
    collBefore = floorZero(entryState.coll - collDelta);
  } else {
    // No same-tx update ran yet (not expected for non-batch ops); the
    // entity still holds pre-operation state — derive forward.
    debtBefore = entryState.debt;
    collBefore = entryState.coll;
    debtAfter = floorZero(entryState.debt + debtDelta);
    collAfter = floorZero(entryState.coll + collDelta);
  }
  const shared = {
    chainId: event.chainId,
    instanceId: args.instanceId,
    troveEntityId: trove.id,
    troveId: trove.troveId,
    owner: asAddress(entryState.owner),
    operation: op,
    collChange: event.params._collChangeFromOperation,
    debtChange: event.params._debtChangeFromOperation,
    debtIncreaseFromUpfrontFee: event.params._debtIncreaseFromUpfrontFee,
    debtIncreaseFromRedist: event.params._debtIncreaseFromRedist,
    collIncreaseFromRedist: event.params._collIncreaseFromRedist,
    annualInterestRate: event.params._annualInterestRate,
    debtBefore,
    debtAfter,
    collBefore,
    collAfter,
    statusBefore: capture?.statusBefore ?? entryState.status,
    statusAfter: trove.status,
    timestamp: args.blockTimestamp,
    blockNumber: args.blockNumber,
    logIndex: event.logIndex,
  };
  if (op === OP.REDEEM_COLLATERAL || op === OP.LIQUIDATE || batched) {
    context.PendingTroveLedgerEvent.set({
      ...shared,
      id: pendingId,
      ledgerEventId: eventId(event.chainId, event.block.number, event.logIndex),
      collateralId: args.collateralId,
      txHash: event.transaction.hash,
      kind:
        op === OP.REDEEM_COLLATERAL
          ? TROVE_LEDGER_KIND.REDEMPTION
          : op === OP.LIQUIDATE
            ? TROVE_LEDGER_KIND.LIQUIDATION
            : TROVE_LEDGER_KIND.BATCH,
      redemptionFeeCredited: undefined,
    });
    return trove;
  }
  context.TroveLedgerEvent.set({
    ...shared,
    id: eventId(event.chainId, event.block.number, event.logIndex),
    redemptionFeeCredited: undefined,
    isRebalance: undefined,
    redemptionPrice: undefined,
    priceAtEvent: args.price ?? undefined,
    icrAfterBps: toLedgerIcrBps(collAfter, debtAfter, args.price),
    txHash: event.transaction.hash,
  });
  return {
    ...trove,
    lastLedgerBlock: args.blockNumber,
    lastLedgerLogIndex: event.logIndex,
  };
}

/** Fold a `RedemptionFeePaidToTrove` fee into the trove's staged op-6 row.
 * The fee event follows `TroveOperation(6)` within the per-trove loop, so
 * the staged row exists by the time this runs. */
export async function attachRedemptionFeeToPendingLedgerRow(
  context: {
    PendingTroveLedgerEvent: {
      get: (id: string) => Promise<PendingTroveLedgerEvent | undefined>;
      set: (entity: PendingTroveLedgerEvent) => void;
    };
  },
  args: {
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    fee: bigint;
  },
): Promise<void> {
  const pendingId = pendingTroveKey(
    args.chainId,
    args.txHash,
    args.collateralId,
    args.troveId,
  );
  const pending = await context.PendingTroveLedgerEvent.get(pendingId);
  if (pending === undefined || pending.kind !== TROVE_LEDGER_KIND.REDEMPTION) {
    return;
  }
  context.PendingTroveLedgerEvent.set({
    ...pending,
    redemptionFeeCredited: (pending.redemptionFeeCredited ?? 0n) + args.fee,
  });
}

export type TroveLedgerFinalizeContext = {
  TroveLedgerEvent: { set: (entity: TroveLedgerEvent) => void };
  PendingTroveLedgerEvent: {
    getWhere: (args: {
      txHash: { _eq: string };
    }) => Promise<PendingTroveLedgerEvent[]>;
    deleteUnsafe: (id: string) => void;
  };
  Trove: {
    get: (id: string) => Promise<Trove | undefined>;
    set: (entity: Trove) => void;
  };
};

/** Finalize this transaction's staged op-6 (kind "redemption") or op-5
 * (kind "liquidation") rows once their aggregate branch event arrives —
 * the only carrier of the exact event price. Writes each row once,
 * complete, stamps the trove's ledger watermark, and deletes the staged
 * row so a second aggregate in the same transaction can never re-consume
 * it. The event price wins for `icrAfterBps`; `priceAtEvent` stays the
 * block-close sample (null when suppressed or unavailable). */
export async function finalizeStagedTroveLedgerRows(
  context: TroveLedgerFinalizeContext,
  args: {
    txHash: string;
    collateralId: string;
    kind: "redemption" | "liquidation";
    /** Block-close price; null when suppressed (replay) or unavailable. */
    blockClosePrice: bigint | null;
    /** Exact event-carried price: `_redemptionPrice` (op 6) or
     * `Liquidation._price` (op 5). */
    eventPrice: bigint;
    /** Op 6 only: tx-target discriminator from the Redemption handler. */
    isRebalance?: boolean;
  },
): Promise<void> {
  const staged = await context.PendingTroveLedgerEvent.getWhere({
    txHash: { _eq: args.txHash },
  });
  const isRedemption = args.kind === TROVE_LEDGER_KIND.REDEMPTION;
  for (const pending of staged) {
    if (pending.collateralId !== args.collateralId) continue;
    if (pending.kind !== args.kind) continue;
    context.TroveLedgerEvent.set({
      id: pending.ledgerEventId,
      chainId: pending.chainId,
      instanceId: pending.instanceId,
      troveEntityId: pending.troveEntityId,
      troveId: pending.troveId,
      owner: pending.owner,
      operation: pending.operation,
      collChange: pending.collChange,
      debtChange: pending.debtChange,
      debtIncreaseFromUpfrontFee: pending.debtIncreaseFromUpfrontFee,
      debtIncreaseFromRedist: pending.debtIncreaseFromRedist,
      collIncreaseFromRedist: pending.collIncreaseFromRedist,
      annualInterestRate: pending.annualInterestRate,
      debtBefore: pending.debtBefore,
      debtAfter: pending.debtAfter,
      collBefore: pending.collBefore,
      collAfter: pending.collAfter,
      statusBefore: pending.statusBefore,
      statusAfter: pending.statusAfter,
      redemptionFeeCredited: isRedemption
        ? (pending.redemptionFeeCredited ?? 0n)
        : undefined,
      isRebalance: isRedemption ? (args.isRebalance ?? false) : undefined,
      redemptionPrice: isRedemption ? args.eventPrice : undefined,
      priceAtEvent: args.blockClosePrice ?? undefined,
      icrAfterBps: toLedgerIcrBps(
        pending.collAfter,
        pending.debtAfter,
        args.eventPrice,
      ),
      timestamp: pending.timestamp,
      blockNumber: pending.blockNumber,
      logIndex: pending.logIndex,
      txHash: pending.txHash,
    });
    const trove = await context.Trove.get(pending.troveEntityId);
    if (trove !== undefined) {
      context.Trove.set({
        ...trove,
        lastLedgerBlock: pending.blockNumber,
        lastLedgerLogIndex: pending.logIndex,
      });
    }
    context.PendingTroveLedgerEvent.deleteUnsafe(pending.id);
  }
}

/** Finalize one staged batch-kind row from the `BatchUpdated` replay — the
 * point where per-trove debt first becomes derivable (share math). The rule
 * for batch rows, stated explicitly: `debtAfter` is the replayed
 * share-derived debt, `statusAfter` is the replayed classification (live
 * `SystemParams` values via `statusFromBatchReplay`, never deploy
 * defaults), and `debtBefore` stays null permanently — per-trove
 * pre-operation debt inside a batch is not derivable from events, and the
 * trove's stale recorded debt is pre-accrual, which would break the
 * post-accrual snapshot contract. Op-5/6 rows on batched troves keep kind
 * "liquidation"/"redemption" and are ignored here — their own finalizers
 * own them. Returns the watermark pair for the caller to stamp on the
 * trove it is about to persist. */
export async function finalizeBatchTroveLedgerRow(
  context: {
    TroveLedgerEvent: { set: (entity: TroveLedgerEvent) => void };
    PendingTroveLedgerEvent: {
      get: (id: string) => Promise<PendingTroveLedgerEvent | undefined>;
      deleteUnsafe: (id: string) => void;
    };
  },
  args: {
    pendingId: string;
    debtAfter: bigint;
    statusAfter: string;
    /** Block-close price; null when suppressed (replay) or unavailable. */
    blockClosePrice: bigint | null;
  },
): Promise<{ blockNumber: bigint; logIndex: number } | undefined> {
  const pending = await context.PendingTroveLedgerEvent.get(args.pendingId);
  if (pending === undefined || pending.kind !== TROVE_LEDGER_KIND.BATCH) {
    return undefined;
  }
  context.TroveLedgerEvent.set({
    id: pending.ledgerEventId,
    chainId: pending.chainId,
    instanceId: pending.instanceId,
    troveEntityId: pending.troveEntityId,
    troveId: pending.troveId,
    owner: pending.owner,
    operation: pending.operation,
    collChange: pending.collChange,
    debtChange: pending.debtChange,
    debtIncreaseFromUpfrontFee: pending.debtIncreaseFromUpfrontFee,
    debtIncreaseFromRedist: pending.debtIncreaseFromRedist,
    collIncreaseFromRedist: pending.collIncreaseFromRedist,
    annualInterestRate: pending.annualInterestRate,
    debtBefore: undefined,
    debtAfter: args.debtAfter,
    collBefore: pending.collBefore,
    collAfter: pending.collAfter,
    statusBefore: pending.statusBefore,
    statusAfter: args.statusAfter,
    redemptionFeeCredited: undefined,
    isRebalance: undefined,
    redemptionPrice: undefined,
    priceAtEvent: args.blockClosePrice ?? undefined,
    icrAfterBps: toLedgerIcrBps(
      pending.collAfter,
      args.debtAfter,
      args.blockClosePrice,
    ),
    timestamp: pending.timestamp,
    blockNumber: pending.blockNumber,
    logIndex: pending.logIndex,
    txHash: pending.txHash,
  });
  context.PendingTroveLedgerEvent.deleteUnsafe(pending.id);
  return { blockNumber: pending.blockNumber, logIndex: pending.logIndex };
}
