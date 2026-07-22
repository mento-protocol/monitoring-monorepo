import { indexer } from "../../indexer.js";
import { asBigInt, eventId, eventIdFromEvent } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import {
  preloadBorrowingRevenueRollover,
  recordBorrowingFeeAndApplyCum,
} from "./borrowingRevenue.js";
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
import {
  classifyKnownPendingStabilityPoolConsumptionSource,
  markPendingStabilityPoolConsumptionSource,
  preloadPendingStabilityPoolConsumptionClassification,
} from "./stabilityPoolLoss.js";
import {
  isPendingBatchRemovalForBatch,
  isPendingBatchReplayRow,
  preloadBatchReplay,
  preloadTroveOperation,
} from "./troveManagerPreload.js";
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
  isForcedOperation,
  transitionClosedTrove,
  transitionLiquidatedTrove,
  transitionOpenedTrove,
} from "./troveManagerTransitions.js";
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
      await Promise.all([
        preloadTroveOperation(context, {
          market,
          chainId: event.chainId,
          txHash: event.transaction.hash,
          collateralId,
          troveId,
          operation: Number(event.params._operation),
          annualInterestRate: event.params._annualInterestRate,
          upfrontFee: event.params._debtIncreaseFromUpfrontFee,
          appliedFeeEventId: eventIdFromEvent(event),
          blockNumber: asBigInt(event.block.number),
          blockTimestamp: asBigInt(event.block.timestamp),
        }),
        preloadBorrowingRevenueRollover(
          context,
          collateralId,
          asBigInt(event.block.timestamp),
        ),
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
      eventIdFromEvent(event),
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
    // preload-handler-note: price and cold-start params are preload-warmed; trove transitions require ordered state.
    // preload-effect-helpers: loadLiquityPrice, getOrLoadSystemParams
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
        preloadBorrowingRevenueRollover(context, collateralId, blockTimestamp),
        preloadInterestRateBracketDebt(context, {
          collateralId,
          prevRate: leavesBatch ? 0n : (trove?.interestRate ?? 0n),
          nextRate: event.params._annualInterestRate,
          prevDebt: leavesBatch ? 0n : (trove?.debt ?? 0n),
          nextDebt: event.params._debt,
          untilTimestamp: blockTimestamp,
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
    // Guard before the write: preload is the read-only cache-warming pass, and
    // this handler reads nothing it needs to warm (the row is built purely from
    // event params). Writing during preload only duplicated the set() the
    // processing pass already performs.
    if (context.isPreload) return;
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
    // preload-handler-note: batch replay warms price and params before ordered trove reconciliation.
    // preload-effect-helpers: loadLiquityPrice, getOrLoadSystemParams
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
        blockTimestamp,
        upfrontFee: event.params._debtIncreaseFromUpfrontFee,
        appliedFeeEventId: eventIdFromEvent(event),
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
      eventIdFromEvent(event),
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
    const collateralId = makeCollateralId(market);
    const hasSpOffset = event.params._debtOffsetBySP > 0n;
    if (hasSpOffset) {
      markPendingStabilityPoolConsumptionSource(context, {
        chainId: event.chainId,
        collateralId,
        txHash: event.transaction.hash,
        source: "liquidation",
        blockNumber: asBigInt(event.block.number),
        blockTimestamp: asBigInt(event.block.timestamp),
      });
    }
    if (context.isPreload) {
      await Promise.all([
        preloadLiquityMarket(context, market),
        preloadBorrowingRevenueRollover(
          context,
          collateralId,
          asBigInt(event.block.timestamp),
        ),
        preloadPendingStabilityPoolConsumptionClassification(
          context,
          event.chainId,
          event.transaction.hash,
          collateralId,
        ),
      ]);
      return;
    }
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    if (hasSpOffset) {
      await classifyKnownPendingStabilityPoolConsumptionSource(context, {
        chainId: event.chainId,
        collateralId,
        txHash: event.transaction.hash,
        source: "liquidation",
      });
    }
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
      await preloadBorrowingRevenueRollover(
        context,
        makeCollateralId(market),
        asBigInt(event.block.timestamp),
      );
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
