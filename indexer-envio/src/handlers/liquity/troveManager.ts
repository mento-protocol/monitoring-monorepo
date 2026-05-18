import { indexer } from "../../indexer.js";
import { asBigInt, eventId } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
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
  getOrCreateTrove,
  isPlaceholderClosedTrove,
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
    get: (id: string) => Promise<unknown>;
  };
  PendingBatchedTroveUpdate: {
    getWhere: (args: { txHash: { _eq: string } }) => Promise<
      Array<{
        collateralId: string;
        batchManager: string;
        logIndex: number;
        troveId: string;
      }>
    >;
  };
};

async function preloadTroveAndMarket(
  context: TroveManagerPreloadContext,
  market: Parameters<typeof preloadSystemParams>[1],
  collateralId: string,
  troveId: string,
): Promise<void> {
  await Promise.all([
    preloadLiquityMarket(context, market),
    context.Trove.get(makeTroveId(collateralId, troveId)),
    context.LiquityCollateral.get(collateralId),
  ]);
}

async function preloadBatchReplay(args: {
  context: TroveManagerPreloadContext;
  market: Parameters<typeof preloadSystemParams>[1];
  chainId: number;
  txHash: string;
  collateralId: string;
  batchManager: string;
  eventLogIndex: number;
}): Promise<void> {
  const pendingRows = await args.context.PendingBatchedTroveUpdate.getWhere({
    txHash: { _eq: args.txHash },
  });
  const relevantRows = pendingRows.filter(
    (pending) =>
      pending.collateralId === args.collateralId &&
      pending.batchManager === args.batchManager &&
      pending.logIndex < args.eventLogIndex,
  );
  await Promise.all([
    preloadLiquityMarket(args.context, args.market),
    preloadSystemParams(args.context, args.market),
    ...relevantRows.flatMap((pending) => [
      args.context.Trove.get(makeTroveId(args.collateralId, pending.troveId)),
      args.context.PendingBatchMembershipOperation.get(
        pendingTroveKey(
          args.chainId,
          args.txHash,
          args.collateralId,
          pending.troveId,
        ),
      ),
    ]),
  ]);
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
      await preloadTroveAndMarket(context, market, collateralId, troveId);
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

    const op = Number(event.params._operation);
    const forced = isForcedOperation(op);

    if (op === OP.OPEN_TROVE || op === OP.OPEN_TROVE_AND_JOIN_BATCH) {
      const transitioned = transitionTroveStatus(
        {
          ...trove,
          openedAt: trove.openedAt === 0n ? blockTimestamp : trove.openedAt,
          openedAtBlock:
            trove.openedAtBlock === 0n ? blockNumber : trove.openedAtBlock,
          openedTxHash: trove.openedTxHash || event.transaction.hash,
        },
        TROVE_STATUS.ACTIVE,
        instance,
      );
      trove = transitioned.trove;
      instance = {
        ...transitioned.instance,
        troveOpenedCountBucket:
          transitioned.instance.troveOpenedCountBucket + 1,
        troveOpenedCountDayBucket:
          transitioned.instance.troveOpenedCountDayBucket + 1,
      };
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
      await Promise.all([
        preloadLiquityMarket(context, market),
        preloadSystemParams(context, market),
        context.Trove.get(makeTroveId(collateralId, troveId)),
        context.PendingRedemption.get(pendingId),
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
    if (context.isPreload) return;
    const troveId = normalizeTroveTokenId(event.params._troveId);
    context.PendingBatchedTroveUpdate.set({
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
    });
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
    const collateral = await getOrLoadSystemParams(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = (await context.LiquityInstance.get(instance.id)) ?? instance;
    for (const pending of pendingRows) {
      if (
        pending.collateralId !== collateralId ||
        pending.batchManager !== batchManager ||
        pending.logIndex >= event.logIndex
      ) {
        continue;
      }
      let trove = await getOrCreateTrove(context, {
        chainId: event.chainId,
        collateralId,
        troveId: pending.troveId,
        blockNumber,
        blockTimestamp,
        txHash: event.transaction.hash,
      });
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
      if (entersBatch) {
        await moveInterestRateBracketDebt(context, {
          collateralId,
          prevRate: trove.interestRate,
          nextRate: 0n,
          prevDebt: trove.debt,
          nextDebt: 0n,
          timestamp: blockTimestamp,
        });
      } else if (leavesBatch) {
        await moveInterestRateBracketDebt(context, {
          collateralId,
          prevRate: 0n,
          nextRate: op.annualInterestRate,
          prevDebt: 0n,
          nextDebt,
          timestamp: blockTimestamp,
        });
      }
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
      redemptionCountCum: next.redemptionCountCum + 1,
      redemptionDebtCum:
        next.redemptionDebtCum + event.params._actualBoldAmount,
      redemptionFeeCum: next.redemptionFeeCum + event.params._ETHFee,
      redemptionCountBucket: next.redemptionCountBucket + 1,
      redemptionDebtBucket:
        next.redemptionDebtBucket + event.params._actualBoldAmount,
      redemptionCountDayBucket: next.redemptionCountDayBucket + 1,
      redemptionDebtDayBucket:
        next.redemptionDebtDayBucket + event.params._actualBoldAmount,
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
