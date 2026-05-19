import type {
  BorrowerInfo,
  InterestRateBracket,
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
import {
  findLiquityMarketByEventSource,
  isLiquidityStrategyAddress,
  makeCollateralId,
} from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { pendingTroveKey } from "./keys.js";
import { negativeToPositive } from "./math.js";
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
  makeInterestRateBracketId,
  makeTroveId,
  normalizeTroveTokenId,
  moveInterestRateBracketDebt,
  statusFromDebt,
  tracksIndividualInterest,
  transitionTroveStatus,
} from "./troves.js";

const statusFromCollateral = (
  debt: bigint,
  collateral: { minDebt: bigint; systemParamsLoaded: boolean } | undefined,
): string => {
  if (debt === 0n) return TROVE_STATUS.REDEEMED;
  if (collateral?.systemParamsLoaded !== true) return TROVE_STATUS.ZOMBIE;
  return statusFromDebt(debt, collateral.minDebt);
};

const statusFromBatchReplay = (
  trove: Parameters<typeof isPlaceholderClosedTrove>[0] & { status: string },
  debt: bigint,
  collateral: { minDebt: bigint; systemParamsLoaded: boolean } | undefined,
): string => {
  if (
    (trove.status === TROVE_STATUS.CLOSED &&
      !isPlaceholderClosedTrove(trove)) ||
    trove.status === TROVE_STATUS.LIQUIDATED
  ) {
    return trove.status;
  }
  return statusFromCollateral(debt, collateral);
};

const isForcedOperation = (op: number): boolean =>
  op === OP.REDEEM_COLLATERAL ||
  op === OP.LIQUIDATE ||
  op === OP.APPLY_PENDING_DEBT;

type TroveManagerPreloadContext = Parameters<typeof preloadSystemParams>[0] & {
  PendingBatchMembershipOperation: {
    get: (id: string) => Promise<PendingBatchMembershipOperation | undefined>;
    set: (entity: PendingBatchMembershipOperation) => void;
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
  BorrowerInfo: {
    get: (id: string) => Promise<BorrowerInfo | undefined>;
    set: (entity: BorrowerInfo) => void;
  };
};
type TroveOperationPreloadContext = TroveManagerPreloadContext & {
  PendingRedemption: {
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

async function preloadInterestRateBracketDebt(
  context: TroveManagerPreloadContext,
  args: {
    collateralId: string;
    prevRate: bigint;
    nextRate: bigint;
    prevDebt: bigint;
    nextDebt: bigint;
  },
): Promise<void> {
  const reads: Array<Promise<InterestRateBracket | undefined>> = [];
  if (args.prevRate !== 0n && args.prevDebt !== 0n) {
    reads.push(
      context.InterestRateBracket.get(
        makeInterestRateBracketId(args.collateralId, args.prevRate),
      ),
    );
  }
  if (args.nextRate !== 0n && args.nextDebt !== 0n) {
    reads.push(
      context.InterestRateBracket.get(
        makeInterestRateBracketId(args.collateralId, args.nextRate),
      ),
    );
  }
  await Promise.all(reads);
}

async function preloadTroveAndMarket(
  context: TroveManagerPreloadContext,
  market: Parameters<typeof preloadSystemParams>[1],
  collateralId: string,
  troveId: string,
): Promise<void> {
  await Promise.all([
    preloadLiquityMarket(context, market),
    context.Trove.get(makeTroveId(collateralId, troveId)),
  ]);
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
  await preloadTroveAndMarket(
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
  prevBatchRate: bigint;
  nextBatchRate: bigint;
  prevBatchDebt: bigint;
  nextBatchDebt: bigint;
  totalDebtShares: bigint;
}): Promise<void> {
  const pendingRows = await args.context.PendingBatchedTroveUpdate.getWhere({
    txHash: { _eq: args.txHash },
  });
  const relevantRows = pendingRows.filter((pending) =>
    isPendingBatchReplayRow(pending, args),
  );
  await Promise.all([
    preloadLiquityMarket(args.context, args.market),
    preloadSystemParams(args.context, args.market),
    preloadInterestRateBracketDebt(args.context, {
      collateralId: args.collateralId,
      prevRate: args.prevBatchRate,
      nextRate: args.nextBatchRate,
      prevDebt: args.prevBatchDebt,
      nextDebt: args.nextBatchDebt,
    }),
    ...relevantRows.map(async (pending) => {
      const [trove, op] = await Promise.all([
        args.context.Trove.get(makeTroveId(args.collateralId, pending.troveId)),
        args.context.PendingBatchMembershipOperation.get(
          pendingTroveKey(
            args.chainId,
            args.txHash,
            args.collateralId,
            pending.troveId,
          ),
        ),
      ]);
      if (trove === undefined) return;
      const leavesBatch = op?.operation === OP.REMOVE_FROM_BATCH;
      const entersBatch = trove.interestBatchId === undefined && !leavesBatch;
      const nextDebt =
        args.totalDebtShares === 0n
          ? 0n
          : (args.nextBatchDebt * pending.batchDebtShares) /
            args.totalDebtShares;
      if (entersBatch) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: trove.interestRate,
          nextRate: 0n,
          prevDebt: trove.debt,
          nextDebt: 0n,
        });
      } else if (leavesBatch) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: 0n,
          nextRate: op.annualInterestRate,
          prevDebt: 0n,
          nextDebt,
        });
      }
    }),
  ]);
}

async function moveBatchMembershipBracketDebt(
  context: TroveManagerPreloadContext,
  args: {
    collateralId: string;
    troveDebt: bigint;
    troveInterestRate: bigint;
    opAnnualInterestRate: bigint;
    leavesBatch: boolean;
    entersBatch: boolean;
    nextDebt: bigint;
    timestamp: bigint;
  },
): Promise<void> {
  if (args.entersBatch) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: args.troveInterestRate,
      nextRate: 0n,
      prevDebt: args.troveDebt,
      nextDebt: 0n,
      timestamp: args.timestamp,
    });
  } else if (args.leavesBatch) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: 0n,
      nextRate: args.opAnnualInterestRate,
      prevDebt: 0n,
      nextDebt: args.nextDebt,
      timestamp: args.timestamp,
    });
  }
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
    instance = flushLiquitySnapshots(
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

    const op = Number(event.params._operation);
    const forced = isForcedOperation(op);

    if (op === OP.OPEN_TROVE || op === OP.OPEN_TROVE_AND_JOIN_BATCH) {
      ({ trove, instance } = transitionOpenedTrove(trove, instance, {
        blockTimestamp,
        blockNumber,
        txHash: event.transaction.hash,
      }));
    } else if (op === OP.CLOSE_TROVE) {
      const transitioned = transitionTroveStatus(
        {
          ...trove,
          closedAt: blockTimestamp,
          closedAtBlock: blockNumber,
          closedTxHash: event.transaction.hash,
        },
        TROVE_STATUS.CLOSED,
        instance,
      );
      trove = transitioned.trove;
      instance = {
        ...transitioned.instance,
        troveClosedCountBucket:
          transitioned.instance.troveClosedCountBucket + 1,
        troveClosedCountDayBucket:
          transitioned.instance.troveClosedCountDayBucket + 1,
      };
    } else if (op === OP.LIQUIDATE) {
      const transitioned = transitionTroveStatus(
        {
          ...trove,
          liquidatedColl: negativeToPositive(
            event.params._collChangeFromOperation,
          ),
          liquidatedDebt: negativeToPositive(
            event.params._debtChangeFromOperation,
          ),
          closedAt: blockTimestamp,
          closedAtBlock: blockNumber,
          closedTxHash: event.transaction.hash,
        },
        TROVE_STATUS.LIQUIDATED,
        instance,
      );
      trove = transitioned.trove;
      instance = {
        ...transitioned.instance,
        liqCountCum: transitioned.instance.liqCountCum + 1,
        liqCountBucket: transitioned.instance.liqCountBucket + 1,
        liqCountDayBucket: transitioned.instance.liqCountDayBucket + 1,
      };
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
        timestamp: blockTimestamp,
        blockNumber,
      });
    }

    if (!forced) trove = { ...trove, lastUserActionAt: blockTimestamp };
    instance = {
      ...instance,
      borrowingFeeCum:
        instance.borrowingFeeCum + event.params._debtIncreaseFromUpfrontFee,
    };
    // TroveOperation handler doesn't mutate `trove.debt` — only status flips
    // (debt changes arrive in the subsequent TroveUpdated). So delta here is
    // driven purely by open↔not-open transitions on the unchanged debt.
    instance = applySystemDebtDelta(instance, prevTroveState, {
      status: trove.status,
      debt: trove.debt,
    });
    context.Trove.set({
      ...trove,
      lastUpdatedAt: blockTimestamp,
      lastUpdatedBlock: blockNumber,
    });
    context.LiquityInstance.set(
      touchLiquityInstance(instance, blockNumber, blockTimestamp),
    );
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
    if (context.isPreload) {
      const trove = await context.Trove.get(makeTroveId(collateralId, troveId));
      await Promise.all([
        preloadLiquityMarket(context, market),
        preloadSystemParams(context, market),
        context.PendingRedemption.get(pendingId),
        preloadInterestRateBracketDebt(context, {
          collateralId,
          prevRate: trove?.interestRate ?? 0n,
          nextRate: event.params._annualInterestRate,
          prevDebt: trove?.debt ?? 0n,
          nextDebt: event.params._debt,
        }),
      ]);
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
    instance = flushLiquitySnapshots(
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
    if (tracksIndividualInterest(trove)) {
      await moveInterestRateBracketDebt(context, {
        collateralId,
        prevRate: trove.interestRate,
        nextRate: event.params._annualInterestRate,
        prevDebt: trove.debt,
        nextDebt: event.params._debt,
        timestamp: blockTimestamp,
      });
    }

    const pendingRedemption = await context.PendingRedemption.get(pendingId);
    trove = {
      ...trove,
      debt: event.params._debt,
      coll: event.params._coll,
      stake: event.params._stake,
      snapshotOfTotalCollRedist: event.params._snapshotOfTotalCollRedist,
      snapshotOfTotalDebtRedist: event.params._snapshotOfTotalDebtRedist,
      interestRate: event.params._annualInterestRate,
      icrBps: -1,
      lastUpdatedAt: blockTimestamp,
      lastUpdatedBlock: blockNumber,
    };
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
        prevBatchRate: existing?.annualInterestRate ?? 0n,
        nextBatchRate: event.params._annualInterestRate,
        prevBatchDebt: existing?.debt ?? 0n,
        nextBatchDebt: event.params._debt,
        totalDebtShares: event.params._totalDebtShares,
      });
      return;
    }
    await moveInterestRateBracketDebt(context, {
      collateralId,
      prevRate: existing?.annualInterestRate ?? 0n,
      nextRate: event.params._annualInterestRate,
      prevDebt: existing?.debt ?? 0n,
      nextDebt: event.params._debt,
      timestamp: blockTimestamp,
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
    instance = flushLiquitySnapshots(
      context,
      instance,
      blockTimestamp,
      blockNumber,
    );

    const pendingRows = await context.PendingBatchedTroveUpdate.getWhere({
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
      let trove = await getOrCreateTrove(context, {
        chainId: event.chainId,
        collateralId,
        troveId: pending.troveId,
        blockNumber,
        blockTimestamp,
        txHash: event.transaction.hash,
      });
      // Per-pending capture; the loop may process many troves per
      // BatchUpdated event, each with its own status/debt flip.
      const prevTroveState = { status: trove.status, debt: trove.debt };
      const nextDebt =
        event.params._totalDebtShares === 0n
          ? 0n
          : (event.params._debt * pending.batchDebtShares) /
            event.params._totalDebtShares;
      const op = await context.PendingBatchMembershipOperation.get(
        pendingTroveKey(
          event.chainId,
          event.transaction.hash,
          collateralId,
          pending.troveId,
        ),
      );
      if (op !== undefined) {
        context.PendingBatchMembershipOperation.deleteUnsafe(op.id);
      }
      const leavesBatch = op?.operation === OP.REMOVE_FROM_BATCH;
      const entersBatch = trove.interestBatchId === undefined && !leavesBatch;
      await moveBatchMembershipBracketDebt(context, {
        collateralId,
        troveDebt: trove.debt,
        troveInterestRate: trove.interestRate,
        opAnnualInterestRate: op?.annualInterestRate ?? 0n,
        leavesBatch,
        entersBatch,
        nextDebt,
        timestamp: blockTimestamp,
      });
      const transitioned = transitionTroveStatus(
        {
          ...trove,
          debt: nextDebt,
          coll: pending.coll,
          stake: pending.stake,
          snapshotOfTotalCollRedist: pending.snapshotOfTotalCollRedist,
          snapshotOfTotalDebtRedist: pending.snapshotOfTotalDebtRedist,
          interestRate: leavesBatch
            ? (op?.annualInterestRate ?? trove.interestRate)
            : event.params._annualInterestRate,
          interestBatchId: leavesBatch ? undefined : batchId,
          batchDebtShares: leavesBatch ? 0n : pending.batchDebtShares,
          icrBps: -1,
          lastUpdatedAt: blockTimestamp,
          lastUpdatedBlock: blockNumber,
        },
        statusFromBatchReplay(trove, nextDebt, collateral),
        instance,
      );
      trove = transitioned.trove;
      instance = transitioned.instance;
      instance = applySystemDebtDelta(instance, prevTroveState, {
        status: trove.status,
        debt: trove.debt,
      });
      context.Trove.set(trove);
      context.PendingBatchedTroveUpdate.deleteUnsafe(pending.id);
    }

    context.LiquityInstance.set({
      ...touchLiquityInstance(instance, blockNumber, blockTimestamp),
      borrowingFeeCum:
        instance.borrowingFeeCum + event.params._debtIncreaseFromUpfrontFee,
    });
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
      flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
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
      flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
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
