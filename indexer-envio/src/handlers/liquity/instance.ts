import type {
  LiquityInstance,
  LiquityInstanceDailySnapshot,
  LiquityInstanceSnapshot,
} from "envio";
import { dayBucket, hourBucket } from "../../helpers.js";

type SnapshotContext = {
  LiquityInstanceSnapshot: { set: (entity: LiquityInstanceSnapshot) => void };
  LiquityInstanceDailySnapshot: {
    set: (entity: LiquityInstanceDailySnapshot) => void;
  };
};

const resetHourBuckets = (
  instance: LiquityInstance,
  nextBucket: bigint,
): LiquityInstance => ({
  ...instance,
  troveOpenedCountBucket: 0,
  troveClosedCountBucket: 0,
  liqCountBucket: 0,
  liqDebtOffsetBucket: 0n,
  redemptionCountBucket: 0,
  redemptionDebtBucket: 0n,
  rebalanceRedemptionCountBucket: 0,
  rebalanceRedemptionDebtBucket: 0n,
  spRebalanceCountBucket: 0,
  shortfallSubsidyBucket: 0n,
  currentHourBucket: nextBucket,
});

const resetDayBuckets = (
  instance: LiquityInstance,
  nextBucket: bigint,
): LiquityInstance => ({
  ...instance,
  troveOpenedCountDayBucket: 0,
  troveClosedCountDayBucket: 0,
  liqCountDayBucket: 0,
  liqDebtOffsetDayBucket: 0n,
  redemptionCountDayBucket: 0,
  redemptionDebtDayBucket: 0n,
  rebalanceRedemptionCountDayBucket: 0,
  rebalanceRedemptionDebtDayBucket: 0n,
  spRebalanceCountDayBucket: 0,
  shortfallSubsidyDayBucket: 0n,
  currentDayBucket: nextBucket,
});

export function flushLiquitySnapshots(
  context: SnapshotContext,
  instance: LiquityInstance,
  timestamp: bigint,
  blockNumber: bigint,
): LiquityInstance {
  let next = instance;
  const eventHour = hourBucket(timestamp);
  if (instance.currentHourBucket < eventHour) {
    context.LiquityInstanceSnapshot.set({
      id: `${instance.id}-${instance.currentHourBucket}`,
      chainId: instance.chainId,
      instanceId: instance.id,
      timestamp: instance.currentHourBucket,
      systemColl: instance.systemColl,
      systemDebt: instance.systemDebt,
      tcrBps: instance.tcrBps,
      spDeposits: instance.spDeposits,
      spColl: instance.spColl,
      spHeadroom: instance.spHeadroom,
      currentRedemptionRateBps: instance.currentRedemptionRateBps,
      activeTroveCount: instance.activeTroveCount,
      icrP1Bps: instance.icrP1Bps,
      icrP5Bps: instance.icrP5Bps,
      icrP50Bps: instance.icrP50Bps,
      icrFracBelowMcrBps: instance.icrFracBelowMcrBps,
      isShutDown: instance.isShutDown,
      troveOpenedCount: instance.troveOpenedCountBucket,
      troveClosedCount: instance.troveClosedCountBucket,
      liqCount: instance.liqCountBucket,
      liqDebtOffsetBucket: instance.liqDebtOffsetBucket,
      redemptionCount: instance.redemptionCountBucket,
      redemptionDebtBucket: instance.redemptionDebtBucket,
      rebalanceRedemptionCount: instance.rebalanceRedemptionCountBucket,
      rebalanceRedemptionDebtBucket: instance.rebalanceRedemptionDebtBucket,
      spRebalanceCount: instance.spRebalanceCountBucket,
      shortfallSubsidyBucket: instance.shortfallSubsidyBucket,
      liqCountCum: instance.liqCountCum,
      redemptionCountCum: instance.redemptionCountCum,
      rebalanceRedemptionCountCum: instance.rebalanceRedemptionCountCum,
      blockNumber,
    });
    next = resetHourBuckets(next, eventHour);
  }

  const eventDay = dayBucket(timestamp);
  if (instance.currentDayBucket < eventDay) {
    context.LiquityInstanceDailySnapshot.set({
      id: `${instance.id}-${instance.currentDayBucket}`,
      chainId: instance.chainId,
      instanceId: instance.id,
      timestamp: instance.currentDayBucket,
      systemColl: instance.systemColl,
      systemDebt: instance.systemDebt,
      tcrBps: instance.tcrBps,
      spDeposits: instance.spDeposits,
      spColl: instance.spColl,
      spHeadroom: instance.spHeadroom,
      currentRedemptionRateBps: instance.currentRedemptionRateBps,
      activeTroveCount: instance.activeTroveCount,
      icrP1Bps: instance.icrP1Bps,
      icrP5Bps: instance.icrP5Bps,
      icrP50Bps: instance.icrP50Bps,
      icrFracBelowMcrBps: instance.icrFracBelowMcrBps,
      isShutDown: instance.isShutDown,
      troveOpenedCount: instance.troveOpenedCountDayBucket,
      troveClosedCount: instance.troveClosedCountDayBucket,
      liqCount: instance.liqCountDayBucket,
      liqDebtOffsetBucket: instance.liqDebtOffsetDayBucket,
      redemptionCount: instance.redemptionCountDayBucket,
      redemptionDebtBucket: instance.redemptionDebtDayBucket,
      rebalanceRedemptionCount: instance.rebalanceRedemptionCountDayBucket,
      rebalanceRedemptionDebtBucket: instance.rebalanceRedemptionDebtDayBucket,
      spRebalanceCount: instance.spRebalanceCountDayBucket,
      shortfallSubsidyBucket: instance.shortfallSubsidyDayBucket,
      liqCountCum: instance.liqCountCum,
      redemptionCountCum: instance.redemptionCountCum,
      rebalanceRedemptionCountCum: instance.rebalanceRedemptionCountCum,
      blockNumber,
    });
    next = resetDayBuckets(next, eventDay);
  }
  return next;
}

export const touchLiquityInstance = (
  instance: LiquityInstance,
  blockNumber: bigint,
  blockTimestamp: bigint,
): LiquityInstance => ({
  ...instance,
  lastEventBlock: blockNumber,
  lastEventTimestamp: blockTimestamp,
});
