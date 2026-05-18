import type { StabilityPoolDepositor } from "envio";
import { indexer } from "../../indexer.js";
import { asAddress, asBigInt, eventId } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { getOrLoadSystemParams, preloadSystemParams } from "./systemParams.js";

const pendingDepositKey = (
  chainId: number,
  txHash: string,
  collateralId: string,
  depositor: string,
): string => `${chainId}-${txHash}-${collateralId}-${asAddress(depositor)}`;

indexer.onEvent(
  { contract: "LiquityStabilityPool", event: "DepositOperation" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const depositor = asAddress(event.params._depositor);
    if (context.isPreload) return;
    context.PendingDepositOperation.set({
      id: pendingDepositKey(
        event.chainId,
        event.transaction.hash,
        collateralId,
        depositor,
      ),
      collateralId,
      txHash: event.transaction.hash,
      depositor,
      topUpOrWithdrawal: event.params._topUpOrWithdrawal,
      yieldGainClaimed: event.params._yieldGainClaimed,
      ethGainClaimed: event.params._ethGainClaimed,
      timestamp: asBigInt(event.block.timestamp),
      blockNumber: asBigInt(event.block.number),
    });
  },
);

indexer.onEvent(
  { contract: "LiquityStabilityPool", event: "DepositUpdated" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const depositor = asAddress(event.params._depositor);
    const id = `${collateralId}-${depositor}`;
    const blockTimestamp = asBigInt(event.block.timestamp);
    const pendingKey = pendingDepositKey(
      event.chainId,
      event.transaction.hash,
      collateralId,
      depositor,
    );
    const [existing, pending] = await Promise.all([
      context.StabilityPoolDepositor.get(id),
      context.PendingDepositOperation.get(pendingKey),
    ]);
    if (context.isPreload) return;
    if (pending !== undefined) {
      context.PendingDepositOperation.deleteUnsafe(pendingKey);
    }
    const topUp = pending?.topUpOrWithdrawal ?? 0n;
    const next: StabilityPoolDepositor = {
      id,
      chainId: event.chainId,
      collateralId,
      address: depositor,
      lastTouchedDeposit: event.params._newDeposit,
      stashedColl: event.params._stashedColl,
      yieldGainClaimedCum:
        (existing?.yieldGainClaimedCum ?? 0n) +
        (pending?.yieldGainClaimed ?? 0n),
      ethGainClaimedCum:
        (existing?.ethGainClaimedCum ?? 0n) + (pending?.ethGainClaimed ?? 0n),
      firstDepositAt:
        existing?.firstDepositAt ??
        (event.params._newDeposit > 0n ? blockTimestamp : 0n),
      lastUpdatedAt: blockTimestamp,
      cumulativeDeposited:
        (existing?.cumulativeDeposited ?? 0n) + (topUp > 0n ? topUp : 0n),
      cumulativeWithdrawn:
        (existing?.cumulativeWithdrawn ?? 0n) + (topUp < 0n ? -topUp : 0n),
    };
    context.StabilityPoolDepositor.set(next);
  },
);

indexer.onEvent(
  {
    contract: "LiquityStabilityPool",
    event: "StabilityPoolBoldBalanceUpdated",
  },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    if (context.isPreload) {
      await Promise.all([
        preloadLiquityMarket(context, market),
        preloadSystemParams(context, market),
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
    const collateral = await getOrLoadSystemParams(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = (await context.LiquityInstance.get(instance.id)) ?? instance;
    const next = touchLiquityInstance(
      flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
      blockNumber,
      blockTimestamp,
    );
    context.LiquityInstance.set({
      ...next,
      spDeposits: event.params._newBalance,
      spHeadroom:
        collateral?.systemParamsLoaded === true
          ? event.params._newBalance - collateral.minBoldInSp
          : -1n,
    });
  },
);

indexer.onEvent(
  {
    contract: "LiquityStabilityPool",
    event: "StabilityPoolCollBalanceUpdated",
  },
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
    context.LiquityInstance.set({
      ...touchLiquityInstance(
        flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
        blockNumber,
        blockTimestamp,
      ),
      spColl: event.params._newBalance,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityStabilityPool", event: "RebalanceExecuted" },
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
    context.SpRebalanceEvent.set({
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      instanceId: instance.id,
      amountCollIn: event.params.amountCollIn,
      amountStableOut: event.params.amountStableOut,
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
      spRebalanceCount: next.spRebalanceCount + 1,
      spRebalanceCollInCum:
        next.spRebalanceCollInCum + event.params.amountCollIn,
      spRebalanceStableOutCum:
        next.spRebalanceStableOutCum + event.params.amountStableOut,
      spRebalanceCountBucket: next.spRebalanceCountBucket + 1,
      spRebalanceCountDayBucket: next.spRebalanceCountDayBucket + 1,
    });
  },
);
