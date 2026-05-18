import { indexer } from "../../indexer.js";
import { asBigInt, eventId } from "../../helpers.js";
import { getOrCreateLiquityInstance } from "./bootstrap.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { negativeToPositive } from "./math.js";
import {
  TROVE_STATUS,
  getOrCreateTrove,
  moveInterestRateBracketDebt,
  statusFromDebt,
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

const OP = {
  OPEN_TROVE: 0,
  CLOSE_TROVE: 1,
  ADJUST_TROVE: 2,
  ADJUST_TROVE_INTEREST_RATE: 3,
  APPLY_PENDING_DEBT: 4,
  LIQUIDATE: 5,
  REDEEM_COLLATERAL: 6,
  OPEN_TROVE_AND_JOIN_BATCH: 7,
  SET_INTEREST_BATCH_MANAGER: 8,
  REMOVE_FROM_BATCH: 9,
} as const;

indexer.onEvent(
  { contract: "LiquityTroveManager", event: "TroveOperation" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
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
    const forced =
      op === OP.REDEEM_COLLATERAL ||
      op === OP.LIQUIDATE ||
      op === OP.APPLY_PENDING_DEBT;

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
      context.PendingRedemption.set({
        id: `${event.chainId}-${event.transaction.hash}-${trove.troveId}`,
        collateralId,
        txHash: event.transaction.hash,
        troveId: trove.troveId,
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
    await moveInterestRateBracketDebt(context, {
      collateralId,
      prevRate: trove.interestRate,
      nextRate: event.params._annualInterestRate,
      prevDebt: trove.debt,
      nextDebt: event.params._debt,
      timestamp: blockTimestamp,
    });

    const pendingId = `${event.chainId}-${event.transaction.hash}-${trove.troveId}`;
    const pendingRedemption = await context.PendingRedemption.get(pendingId);
    trove = {
      ...trove,
      debt: event.params._debt,
      coll: event.params._coll,
      stake: event.params._stake,
      snapshotOfTotalCollRedist: event.params._snapshotOfTotalCollRedist,
      snapshotOfTotalDebtRedist: event.params._snapshotOfTotalDebtRedist,
      interestRate: event.params._annualInterestRate,
      interestBatchId: undefined,
      batchDebtShares: 0n,
      icrBps: -1,
      lastUpdatedAt: blockTimestamp,
      lastUpdatedBlock: blockNumber,
    };
    if (
      trove.status !== TROVE_STATUS.CLOSED &&
      trove.status !== TROVE_STATUS.LIQUIDATED
    ) {
      const collateral = await context.LiquityCollateral.get(collateralId);
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
    const troveId = `0x${event.params._troveId.toString(16)}`;
    context.PendingBatchedTroveUpdate.set({
      id: `${event.chainId}-${event.transaction.hash}-${event.params._interestBatchManager}-${troveId}`,
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

    const blockNumber = asBigInt(event.block.number);
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
      batchManager: { _eq: batchManager },
    });
    const collateral = await context.LiquityCollateral.get(collateralId);
    for (const pending of pendingRows) {
      if (
        pending.collateralId !== collateralId ||
        pending.batchManager !== batchManager
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
      const transitioned = transitionTroveStatus(
        {
          ...trove,
          debt: nextDebt,
          coll: pending.coll,
          stake: pending.stake,
          snapshotOfTotalCollRedist: pending.snapshotOfTotalCollRedist,
          snapshotOfTotalDebtRedist: pending.snapshotOfTotalDebtRedist,
          interestRate: event.params._annualInterestRate,
          interestBatchId: batchId,
          batchDebtShares: pending.batchDebtShares,
          icrBps: -1,
          lastUpdatedAt: blockTimestamp,
          lastUpdatedBlock: blockNumber,
        },
        statusFromCollateral(nextDebt, collateral),
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
