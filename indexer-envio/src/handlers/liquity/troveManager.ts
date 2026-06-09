import type {
  BorrowerInfo,
  InterestRateBracket,
  LiquityBorrowingRevenueDailySnapshot,
  PendingBatchMembershipOperation,
  PendingBatchedTroveUpdate,
  PendingRedemption,
  LiquityInstance,
  Trove,
} from "envio";
import { indexer } from "../../indexer.js";
import { asBigInt, eventId } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { recordBorrowingFeeAndApplyCum } from "./borrowingRevenue.js";
import { replayBatchedTroveUpdate } from "./batchReplay.js";
import {
  findLiquityMarketByEventSource,
  isLiquidityStrategyAddress,
  makeCollateralId,
} from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { pendingTroveKey } from "./keys.js";
import { computeTroveIcrBps, negativeToPositive } from "./math.js";
import { loadLiquityPrice } from "./priceFeed.js";
import type { LiquityPriceContext } from "./priceFeed.js";
import {
  captureTroveOperationSnapshotState,
  maybeRecordTroveOperation,
} from "./troveOperationSnapshot.js";
import {
  applyTroveUpdatedFields,
  moveTroveUpdatedInterestRateBracketDebt,
  removesFromBatch,
} from "./troveUpdates.js";
import { OP, isBatchMembershipOperation } from "./operations.js";
import {
  setPendingBatchMembershipOperation,
  setPendingRedemption,
} from "./pendingOperations.js";
import { getOrLoadSystemParams, preloadSystemParams } from "./systemParams.js";
import {
  TROVE_STATUS,
  applySystemDebtDelta,
  getOrCreateTrove,
  isPlaceholderClosedTrove,
  makeTroveId,
  normalizeTroveTokenId,
  moveInterestRateBracketDebt,
  preloadInterestRateBracketDebt,
  statusFromCollateral,
  transitionTroveStatus,
  touchTroveUpdated,
} from "./troves.js";

const isForcedOperation = (op: number): boolean =>
  op === OP.REDEEM_COLLATERAL ||
  op === OP.LIQUIDATE ||
  op === OP.APPLY_PENDING_DEBT;

type TroveManagerPreloadContext = Parameters<typeof preloadSystemParams>[0] &
  LiquityPriceContext & {
    PendingBatchMembershipOperation: {
      get: (id: string) => Promise<PendingBatchMembershipOperation | undefined>;
      getWhere: (args: {
        txHash: { _eq: string };
      }) => Promise<PendingBatchMembershipOperation[]>;
      set: (entity: PendingBatchMembershipOperation) => void;
      deleteUnsafe: (id: string) => void;
    };
    PendingRedemption: {
      get: (id: string) => Promise<PendingRedemption | undefined>;
    };
    PendingBatchedTroveUpdate: {
      getWhere: (args: { txHash: { _eq: string } }) => Promise<
        Array<{
          collateralId: string;
          batchManager: string;
          logIndex: number;
          troveId: string;
          batchDebtShares: bigint;
        }>
      >;
      set: (entity: PendingBatchedTroveUpdate) => void;
    };
    InterestRateBracket: {
      get: (id: string) => Promise<InterestRateBracket | undefined>;
      set: (entity: InterestRateBracket) => void;
    };
    LiquityBorrowingRevenueDailySnapshot: {
      get: (
        id: string,
      ) => Promise<LiquityBorrowingRevenueDailySnapshot | undefined>;
      set: (entity: LiquityBorrowingRevenueDailySnapshot) => void;
    };
    BorrowerInfo: {
      get: (id: string) => Promise<BorrowerInfo | undefined>;
      set: (entity: BorrowerInfo) => void;
    };
  };
type TroveOperationPreloadContext = TroveManagerPreloadContext & {
  PendingRedemption: {
    get: (id: string) => Promise<PendingRedemption | undefined>;
    set: (entity: PendingRedemption) => void;
  };
};
type PendingBatchedTroveUpdateRow = Awaited<
  ReturnType<
    TroveManagerPreloadContext["PendingBatchedTroveUpdate"]["getWhere"]
  >
>[number];

function isPendingBatchReplayRow(
  pending: PendingBatchedTroveUpdateRow,
  args: {
    collateralId: string;
    batchManager: string;
    eventLogIndex: number;
  },
): boolean {
  return (
    pending.collateralId === args.collateralId &&
    pending.batchManager === args.batchManager &&
    pending.logIndex < args.eventLogIndex
  );
}

function isPendingBatchRemovalForBatch(
  pending: PendingBatchMembershipOperation,
  args: { collateralId: string; batchId: string },
): boolean {
  return (
    pending.collateralId === args.collateralId &&
    pending.operation === OP.REMOVE_FROM_BATCH &&
    pending.interestBatchId === args.batchId
  );
}

async function preloadTroveAndMarket(
  context: TroveManagerPreloadContext,
  market: Parameters<typeof preloadSystemParams>[1],
  collateralId: string,
  troveId: string,
): Promise<Trove | undefined> {
  const [, trove] = await Promise.all([
    preloadLiquityMarket(context, market),
    context.Trove.get(makeTroveId(collateralId, troveId)),
  ]);
  return trove;
}

async function preloadTroveOperation(
  context: TroveOperationPreloadContext,
  args: {
    market: Parameters<typeof preloadSystemParams>[1];
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    operation: number;
    annualInterestRate: bigint;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<void> {
  const trove = await preloadTroveAndMarket(
    context,
    args.market,
    args.collateralId,
    args.troveId,
  );
  if (args.operation === OP.REDEEM_COLLATERAL) {
    setPendingRedemption(context, {
      ...args,
      timestamp: args.blockTimestamp,
    });
  } else if (isBatchMembershipOperation(args.operation)) {
    setPendingBatchMembershipOperation(context, {
      ...args,
      operation: args.operation,
      interestBatchId: trove?.interestBatchId,
      timestamp: args.blockTimestamp,
    });
  }
}

async function preloadBatchReplay(args: {
  context: TroveManagerPreloadContext;
  market: Parameters<typeof preloadSystemParams>[1];
  chainId: number;
  txHash: string;
  collateralId: string;
  batchManager: string;
  eventLogIndex: number;
  blockNumber: bigint;
  prevBatchRate: bigint;
  nextBatchRate: bigint;
  prevBatchDebt: bigint;
  nextBatchDebt: bigint;
  totalDebtShares: bigint;
}): Promise<void> {
  const pendingRows = await args.context.PendingBatchedTroveUpdate.getWhere({
    txHash: { _eq: args.txHash },
  });
  const pendingBatchOps =
    await args.context.PendingBatchMembershipOperation.getWhere({
      txHash: { _eq: args.txHash },
    });
  const relevantRows = pendingRows.filter((pending) =>
    isPendingBatchReplayRow(pending, args),
  );
  await Promise.all([
    preloadLiquityMarket(args.context, args.market),
    preloadSystemParams(args.context, args.market),
    loadLiquityPrice(args.context, args.market, args.blockNumber),
    preloadInterestRateBracketDebt(args.context, {
      collateralId: args.collateralId,
      prevRate: args.prevBatchRate,
      nextRate: args.nextBatchRate,
      prevDebt: args.prevBatchDebt,
      nextDebt: args.nextBatchDebt,
    }),
    ...relevantRows.map(async (pending) => {
      const pendingId = pendingTroveKey(
        args.chainId,
        args.txHash,
        args.collateralId,
        pending.troveId,
      );
      const [trove, op] = await Promise.all([
        args.context.Trove.get(makeTroveId(args.collateralId, pending.troveId)),
        args.context.PendingBatchMembershipOperation.get(pendingId),
        args.context.PendingRedemption.get(pendingId),
      ]);
      if (trove === undefined) return;
      const leavesBatch = op?.operation === OP.REMOVE_FROM_BATCH;
      const entersBatch = trove.interestBatchId === undefined && !leavesBatch;
      const batchShareDebt =
        args.totalDebtShares === 0n
          ? 0n
          : (args.nextBatchDebt * pending.batchDebtShares) /
            args.totalDebtShares;
      const nextDebt = leavesBatch ? trove.debt : batchShareDebt;
      if (entersBatch) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: trove.interestRate,
          nextRate: 0n,
          prevDebt: trove.debt,
          nextDebt: 0n,
        });
      } else if (leavesBatch && trove.interestBatchId !== undefined) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: 0n,
          nextRate: op.annualInterestRate,
          prevDebt: 0n,
          nextDebt,
        });
      }
    }),
    ...pendingBatchOps
      .filter((pending) =>
        isPendingBatchRemovalForBatch(pending, {
          collateralId: args.collateralId,
          batchId: `${args.collateralId}-${args.batchManager}`,
        }),
      )
      .map((pending) =>
        args.context.PendingBatchMembershipOperation.get(pending.id),
      ),
  ]);
}

function transitionOpenedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: { blockTimestamp: bigint; blockNumber: bigint; txHash: string },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      openedAt: trove.openedAt === 0n ? args.blockTimestamp : trove.openedAt,
      openedAtBlock:
        trove.openedAtBlock === 0n ? args.blockNumber : trove.openedAtBlock,
      openedTxHash: trove.openedTxHash || args.txHash,
    },
    TROVE_STATUS.ACTIVE,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      troveOpenedCountBucket: transitioned.instance.troveOpenedCountBucket + 1,
      troveOpenedCountDayBucket:
        transitioned.instance.troveOpenedCountDayBucket + 1,
    },
  };
}

function transitionClosedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: { blockTimestamp: bigint; blockNumber: bigint; txHash: string },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      closedAt: args.blockTimestamp,
      closedAtBlock: args.blockNumber,
      closedTxHash: args.txHash,
    },
    TROVE_STATUS.CLOSED,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      troveClosedCountBucket: transitioned.instance.troveClosedCountBucket + 1,
      troveClosedCountDayBucket:
        transitioned.instance.troveClosedCountDayBucket + 1,
    },
  };
}

function transitionLiquidatedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: {
    collChange: bigint;
    debtChange: bigint;
    blockTimestamp: bigint;
    blockNumber: bigint;
    txHash: string;
  },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      liquidatedColl: negativeToPositive(args.collChange),
      liquidatedDebt: negativeToPositive(args.debtChange),
      closedAt: args.blockTimestamp,
      closedAtBlock: args.blockNumber,
      closedTxHash: args.txHash,
    },
    TROVE_STATUS.LIQUIDATED,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      liqCountCum: transitioned.instance.liqCountCum + 1,
      liqCountBucket: transitioned.instance.liqCountBucket + 1,
      liqCountDayBucket: transitioned.instance.liqCountDayBucket + 1,
    },
  };
}

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "TroveOperation" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const troveId = normalizeTroveTokenId(event.params._troveId);
    if (context.isPreload) {
      await preloadTroveOperation(context, {
        market,
        chainId: event.chainId,
        txHash: event.transaction.hash,
        collateralId,
        troveId,
        operation: Number(event.params._operation),
        annualInterestRate: event.params._annualInterestRate,
        blockNumber: asBigInt(event.block.number),
        blockTimestamp: asBigInt(event.block.timestamp),
      });
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    let instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = await flushLiquitySnapshots(
      context,
      instance,
      blockTimestamp,
      blockNumber,
    );

    let trove = await getOrCreateTrove(context, {
      chainId: event.chainId,
      collateralId,
      troveId: event.params._troveId,
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });
    const prevTroveState = { status: trove.status, debt: trove.debt };
    // See `captureTroveOperationSnapshotState` for why we capture these now.
    const snapshotState = captureTroveOperationSnapshotState(trove);

    const op = Number(event.params._operation);
    const forced = isForcedOperation(op);

    if (op === OP.OPEN_TROVE || op === OP.OPEN_TROVE_AND_JOIN_BATCH) {
      ({ trove, instance } = transitionOpenedTrove(trove, instance, {
        blockTimestamp,
        blockNumber,
        txHash: event.transaction.hash,
      }));
    } else if (op === OP.CLOSE_TROVE) {
      ({ trove, instance } = transitionClosedTrove(trove, instance, {
        blockTimestamp,
        blockNumber,
        txHash: event.transaction.hash,
      }));
    } else if (op === OP.LIQUIDATE) {
      ({ trove, instance } = transitionLiquidatedTrove(trove, instance, {
        collChange: event.params._collChangeFromOperation,
        debtChange: event.params._debtChangeFromOperation,
        blockTimestamp,
        blockNumber,
        txHash: event.transaction.hash,
      }));
    } else if (op === OP.REDEEM_COLLATERAL) {
      trove = {
        ...trove,
        redemptionCount: trove.redemptionCount + 1,
        redeemedColl:
          trove.redeemedColl +
          negativeToPositive(event.params._collChangeFromOperation),
        redeemedDebt:
          trove.redeemedDebt +
          negativeToPositive(event.params._debtChangeFromOperation),
      };
      const collateral = await context.LiquityCollateral.get(collateralId);
      const nextStatus = statusFromCollateral(trove.debt, collateral);
      const transitioned = transitionTroveStatus(trove, nextStatus, instance);
      trove = transitioned.trove;
      instance = transitioned.instance;
      setPendingRedemption(context, {
        chainId: event.chainId,
        txHash: event.transaction.hash,
        collateralId,
        troveId: trove.troveId,
        timestamp: blockTimestamp,
        blockNumber,
      });
    } else if (isBatchMembershipOperation(op)) {
      setPendingBatchMembershipOperation(context, {
        chainId: event.chainId,
        txHash: event.transaction.hash,
        collateralId,
        troveId: trove.troveId,
        operation: op,
        annualInterestRate: event.params._annualInterestRate,
        interestBatchId: trove.interestBatchId,
        timestamp: blockTimestamp,
        blockNumber,
      });
    }

    if (!forced) trove = { ...trove, lastUserActionAt: blockTimestamp };
    instance = await recordBorrowingFeeAndApplyCum(
      context,
      instance,
      event.params._debtIncreaseFromUpfrontFee,
      blockTimestamp,
      blockNumber,
    );
    // TroveOperation only flips status — debt arrives in TroveUpdated.
    instance = applySystemDebtDelta(instance, prevTroveState, {
      status: trove.status,
      debt: trove.debt,
    });
    context.Trove.set(
      touchTroveUpdated(
        trove,
        blockTimestamp,
        blockNumber,
        event.transaction.hash,
      ),
    );
    context.LiquityInstance.set(
      touchLiquityInstance(instance, blockNumber, blockTimestamp),
    );
    maybeRecordTroveOperation({
      context,
      op,
      event,
      instanceId: instance.id,
      troveId,
      snapshotState,
      blockNumber,
      blockTimestamp,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "TroveUpdated" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const troveId = normalizeTroveTokenId(event.params._troveId);
    const pendingId = pendingTroveKey(
      event.chainId,
      event.transaction.hash,
      collateralId,
      troveId,
    );
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    if (context.isPreload) {
      const [trove, pendingBatchOperation] = await Promise.all([
        context.Trove.get(makeTroveId(collateralId, troveId)),
        context.PendingBatchMembershipOperation.get(pendingId),
      ]);
      const leavesBatch = removesFromBatch(pendingBatchOperation);
      await Promise.all([
        preloadLiquityMarket(context, market),
        preloadSystemParams(context, market),
        loadLiquityPrice(context, market, blockNumber),
        context.PendingRedemption.get(pendingId),
        preloadInterestRateBracketDebt(context, {
          collateralId,
          prevRate: leavesBatch ? 0n : (trove?.interestRate ?? 0n),
          nextRate: event.params._annualInterestRate,
          prevDebt: leavesBatch ? 0n : (trove?.debt ?? 0n),
          nextDebt: event.params._debt,
        }),
      ]);
      return;
    }
    const price = await loadLiquityPrice(context, market, blockNumber);
    let instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = await flushLiquitySnapshots(
      context,
      instance,
      blockTimestamp,
      blockNumber,
    );
    let trove = await getOrCreateTrove(context, {
      chainId: event.chainId,
      collateralId,
      troveId: event.params._troveId,
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });
    // Capture prev contribution BEFORE any mutation (bracket-debt move,
    // debt overwrite, reclassified re-read all happen below). Single
    // capture point so the delta math at the end is unambiguous.
    const prevTroveState = { status: trove.status, debt: trove.debt };
    const [pendingRedemption, pendingBatchOperation] = await Promise.all([
      context.PendingRedemption.get(pendingId),
      context.PendingBatchMembershipOperation.get(pendingId),
    ]);
    await moveTroveUpdatedInterestRateBracketDebt(context, {
      chainId: event.chainId,
      collateralId,
      trove,
      pendingBatchOperation,
      annualInterestRate: event.params._annualInterestRate,
      debt: event.params._debt,
      timestamp: blockTimestamp,
      blockNumber,
    });

    trove = applyTroveUpdatedFields(trove, {
      debt: event.params._debt,
      coll: event.params._coll,
      stake: event.params._stake,
      snapshotOfTotalCollRedist: event.params._snapshotOfTotalCollRedist,
      snapshotOfTotalDebtRedist: event.params._snapshotOfTotalDebtRedist,
      annualInterestRate: event.params._annualInterestRate,
      icrBps: computeTroveIcrBps({
        coll: event.params._coll,
        debt: event.params._debt,
        price,
      }),
      blockTimestamp,
      blockNumber,
      txHash: event.transaction.hash,
      pendingBatchOperation,
    });
    if (
      (trove.status !== TROVE_STATUS.CLOSED ||
        isPlaceholderClosedTrove(trove)) &&
      trove.status !== TROVE_STATUS.LIQUIDATED
    ) {
      const collateral = await getOrLoadSystemParams(
        context,
        market,
        blockNumber,
        blockTimestamp,
      );
      instance = (await context.LiquityInstance.get(instance.id)) ?? instance;
      const reclassifiedTrove = await context.Trove.get(trove.id);
      if (reclassifiedTrove !== undefined) {
        trove = { ...trove, status: reclassifiedTrove.status };
      }
      const nextStatus = statusFromCollateral(trove.debt, collateral);
      const transitioned = transitionTroveStatus(trove, nextStatus, instance);
      trove = transitioned.trove;
      instance = transitioned.instance;
    }
    // Combined delta: handles both debt change and any status flip the
    // transitionTroveStatus call above performed. Closed/liquidated branches
    // skip the transition but still flow through here as a no-op (both prev
    // and next are not-open ⇒ zero contribution delta).
    instance = applySystemDebtDelta(instance, prevTroveState, {
      status: trove.status,
      debt: trove.debt,
    });
    context.Trove.set(trove);
    if (pendingRedemption !== undefined) {
      context.PendingRedemption.deleteUnsafe(pendingId);
    }
    context.LiquityInstance.set(
      touchLiquityInstance(instance, blockNumber, blockTimestamp),
    );
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "BatchedTroveUpdated" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const troveId = normalizeTroveTokenId(event.params._troveId);
    const pendingUpdate = {
      id: pendingTroveKey(
        event.chainId,
        event.transaction.hash,
        collateralId,
        troveId,
      ),
      collateralId,
      txHash: event.transaction.hash,
      batchManager: event.params._interestBatchManager.toLowerCase(),
      troveId,
      batchDebtShares: event.params._batchDebtShares,
      coll: event.params._coll,
      stake: event.params._stake,
      snapshotOfTotalCollRedist: event.params._snapshotOfTotalCollRedist,
      snapshotOfTotalDebtRedist: event.params._snapshotOfTotalDebtRedist,
      timestamp: asBigInt(event.block.timestamp),
      blockNumber: asBigInt(event.block.number),
      logIndex: event.logIndex,
    };
    context.PendingBatchedTroveUpdate.set(pendingUpdate);
    if (context.isPreload) return;
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "BatchUpdated" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const batchManager = event.params._interestBatchManager.toLowerCase();
    const batchId = `${collateralId}-${batchManager}`;
    const blockTimestamp = asBigInt(event.block.timestamp);
    const existing = await context.InterestBatch.get(batchId);
    const blockNumber = asBigInt(event.block.number);
    if (context.isPreload) {
      await preloadBatchReplay({
        context,
        market,
        chainId: event.chainId,
        txHash: event.transaction.hash,
        collateralId,
        batchManager,
        eventLogIndex: event.logIndex,
        blockNumber,
        prevBatchRate: existing?.annualInterestRate ?? 0n,
        nextBatchRate: event.params._annualInterestRate,
        prevBatchDebt: existing?.debt ?? 0n,
        nextBatchDebt: event.params._debt,
        totalDebtShares: event.params._totalDebtShares,
      });
      return;
    }
    const price = await loadLiquityPrice(context, market, blockNumber);
    await moveInterestRateBracketDebt(context, {
      chainId: event.chainId,
      collateralId,
      prevRate: existing?.annualInterestRate ?? 0n,
      nextRate: event.params._annualInterestRate,
      prevDebt: existing?.debt ?? 0n,
      nextDebt: event.params._debt,
      timestamp: blockTimestamp,
      blockNumber,
    });
    context.InterestBatch.set({
      id: batchId,
      collateralId,
      batchManager,
      debt: event.params._debt,
      coll: event.params._coll,
      totalDebtShares: event.params._totalDebtShares,
      annualInterestRate: event.params._annualInterestRate,
      annualManagementFee: event.params._annualManagementFee,
      updatedAt: blockTimestamp,
    });

    let instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = await flushLiquitySnapshots(
      context,
      instance,
      blockTimestamp,
      blockNumber,
    );

    const pendingRows = await context.PendingBatchedTroveUpdate.getWhere({
      txHash: { _eq: event.transaction.hash },
    });
    const pendingBatchOps =
      await context.PendingBatchMembershipOperation.getWhere({
        txHash: { _eq: event.transaction.hash },
      });
    const relevantRows = pendingRows.filter((pending) =>
      isPendingBatchReplayRow(pending, {
        collateralId,
        batchManager,
        eventLogIndex: event.logIndex,
      }),
    );
    const collateral = await getOrLoadSystemParams(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = (await context.LiquityInstance.get(instance.id)) ?? instance;
    for (const pending of relevantRows) {
      instance = await replayBatchedTroveUpdate(context, {
        chainId: event.chainId,
        txHash: event.transaction.hash,
        collateralId,
        batchId,
        pending,
        blockNumber,
        blockTimestamp,
        batchDebt: event.params._debt,
        totalDebtShares: event.params._totalDebtShares,
        annualInterestRate: event.params._annualInterestRate,
        price,
        collateral,
        instance,
      });
    }
    const replayedPendingIds = new Set(
      relevantRows.map((pending) =>
        pendingTroveKey(
          event.chainId,
          event.transaction.hash,
          collateralId,
          pending.troveId,
        ),
      ),
    );
    for (const pending of pendingBatchOps) {
      if (
        !replayedPendingIds.has(pending.id) &&
        isPendingBatchRemovalForBatch(pending, { collateralId, batchId })
      ) {
        context.PendingBatchMembershipOperation.deleteUnsafe(pending.id);
      }
    }

    instance = await recordBorrowingFeeAndApplyCum(
      context,
      instance,
      event.params._debtIncreaseFromUpfrontFee,
      blockTimestamp,
      blockNumber,
    );
    context.LiquityInstance.set(
      touchLiquityInstance(instance, blockNumber, blockTimestamp),
    );
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "Liquidation" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    if (context.isPreload) {
      await preloadLiquityMarket(context, market);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    context.LiquidationEvent.set({
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      instanceId: instance.id,
      debtOffsetBySP: event.params._debtOffsetBySP,
      debtRedistributed: event.params._debtRedistributed,
      boldGasCompensation: event.params._boldGasCompensation,
      collGasCompensation: event.params._collGasCompensation,
      collSentToSP: event.params._collSentToSP,
      collRedistributed: event.params._collRedistributed,
      collSurplus: event.params._collSurplus,
      L_ETH: event.params._L_ETH,
      L_boldDebt: event.params._L_boldDebt,
      priceAtLiquidation: event.params._price,
      timestamp: blockTimestamp,
      blockNumber,
      txHash: event.transaction.hash,
    });
    const next = touchLiquityInstance(
      await flushLiquitySnapshots(
        context,
        instance,
        blockTimestamp,
        blockNumber,
      ),
      blockNumber,
      blockTimestamp,
    );
    context.LiquityInstance.set({
      ...next,
      liqDebtOffsetCum: next.liqDebtOffsetCum + event.params._debtOffsetBySP,
      liqDebtRedistributedCum:
        next.liqDebtRedistributedCum + event.params._debtRedistributed,
      liqCollSentToSpCum: next.liqCollSentToSpCum + event.params._collSentToSP,
      liqCollRedistributedCum:
        next.liqCollRedistributedCum + event.params._collRedistributed,
      liqDebtOffsetBucket:
        next.liqDebtOffsetBucket + event.params._debtOffsetBySP,
      liqDebtOffsetDayBucket:
        next.liqDebtOffsetDayBucket + event.params._debtOffsetBySP,
      latestTotalCollRedist: event.params._L_ETH,
      latestTotalDebtRedist: event.params._L_boldDebt,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "Redemption" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    if (context.isPreload) {
      await preloadLiquityMarket(context, market);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    // PR #31 in mento-protocol/bold added CDPLiquidityStrategy-only path
    // `redeemCollateralRebalancing` that routes through TroveManager.redeemCollateral
    // and fires this same event. Discriminator: tx.to == liquidityStrategy.
    // On Celo today (2026-05-19) ALL observed redemptions are rebalance-driven.
    const isRebalance = isLiquidityStrategyAddress(
      event.chainId,
      event.transaction.to,
    );
    context.RedemptionEvent.set({
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      instanceId: instance.id,
      attemptedBoldAmount: event.params._attemptedBoldAmount,
      actualBoldAmount: event.params._actualBoldAmount,
      ETHSent: event.params._ETHSent,
      ETHFee: event.params._ETHFee,
      price: event.params._price,
      redemptionPrice: event.params._redemptionPrice,
      isRebalance,
      timestamp: blockTimestamp,
      blockNumber,
      txHash: event.transaction.hash,
    });
    const next = touchLiquityInstance(
      await flushLiquitySnapshots(
        context,
        instance,
        blockTimestamp,
        blockNumber,
      ),
      blockNumber,
      blockTimestamp,
    );
    // Totals always increment; rebalance subset increments in addition so
    // consumers can compute user-driven = total − rebalance without breaking
    // the existing redemptionCountCum semantic.
    const debt = event.params._actualBoldAmount;
    const fee = event.params._ETHFee;
    const rCount = isRebalance ? 1 : 0;
    const rDebt = isRebalance ? debt : 0n;
    const rFee = isRebalance ? fee : 0n;
    context.LiquityInstance.set({
      ...next,
      redemptionCountCum: next.redemptionCountCum + 1,
      redemptionDebtCum: next.redemptionDebtCum + debt,
      redemptionFeeCum: next.redemptionFeeCum + fee,
      redemptionCountBucket: next.redemptionCountBucket + 1,
      redemptionDebtBucket: next.redemptionDebtBucket + debt,
      redemptionCountDayBucket: next.redemptionCountDayBucket + 1,
      redemptionDebtDayBucket: next.redemptionDebtDayBucket + debt,
      rebalanceRedemptionCountCum: next.rebalanceRedemptionCountCum + rCount,
      rebalanceRedemptionDebtCum: next.rebalanceRedemptionDebtCum + rDebt,
      rebalanceRedemptionFeeCum: next.rebalanceRedemptionFeeCum + rFee,
      rebalanceRedemptionCountBucket:
        next.rebalanceRedemptionCountBucket + rCount,
      rebalanceRedemptionDebtBucket: next.rebalanceRedemptionDebtBucket + rDebt,
      rebalanceRedemptionCountDayBucket:
        next.rebalanceRedemptionCountDayBucket + rCount,
      rebalanceRedemptionDebtDayBucket:
        next.rebalanceRedemptionDebtDayBucket + rDebt,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "RedemptionFeePaidToTrove" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    if (context.isPreload) {
      await context.Trove.get(
        makeTroveId(collateralId, normalizeTroveTokenId(event.params._troveId)),
      );
      return;
    }
    const trove = await getOrCreateTrove(context, {
      chainId: event.chainId,
      collateralId,
      troveId: event.params._troveId,
      blockNumber: asBigInt(event.block.number),
      blockTimestamp: asBigInt(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    context.Trove.set({
      ...trove,
      redemptionFeePaidCum: trove.redemptionFeePaidCum + event.params._ETHFee,
    });
  },
);
