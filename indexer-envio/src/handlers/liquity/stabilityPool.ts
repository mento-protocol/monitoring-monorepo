import type {
  StabilityPoolDepositor,
  StabilityPoolOperationEvent,
} from "envio";
import { indexer } from "../../indexer.js";
import { asAddress, asBigInt, eventId } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { preloadBorrowingRevenueRollover } from "./borrowingRevenue.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { getOrLoadSystemParams, preloadSystemParams } from "./systemParams.js";

const pendingDepositKey = (
  chainId: number,
  txHash: string,
  collateralId: string,
  depositor: string,
): string => `${chainId}-${txHash}-${collateralId}-${asAddress(depositor)}`;

export type StabilityPoolPendingOperation = {
  operation: number;
  depositLossSinceLastOperation: bigint;
  topUpOrWithdrawal: bigint;
  yieldGainSinceLastOperation: bigint;
  yieldGainClaimed: bigint;
  ethGainSinceLastOperation: bigint;
  ethGainClaimed: bigint;
};

const EMPTY_PENDING_OPERATION: StabilityPoolPendingOperation = {
  operation: -1,
  depositLossSinceLastOperation: 0n,
  topUpOrWithdrawal: 0n,
  yieldGainSinceLastOperation: 0n,
  yieldGainClaimed: 0n,
  ethGainSinceLastOperation: 0n,
  ethGainClaimed: 0n,
};

export function buildStabilityPoolDepositorUpdate({
  chainId,
  collateralId,
  depositor,
  newDeposit,
  stashedColl,
  blockTimestamp,
  existing,
  pending,
}: {
  chainId: number;
  collateralId: string;
  depositor: string;
  newDeposit: bigint;
  stashedColl: bigint;
  blockTimestamp: bigint;
  existing: StabilityPoolDepositor | undefined;
  pending: StabilityPoolPendingOperation | undefined;
}): StabilityPoolDepositor {
  const op = pending ?? EMPTY_PENDING_OPERATION;
  return {
    id: `${collateralId}-${depositor}`,
    chainId,
    collateralId,
    address: depositor,
    lastTouchedDeposit: newDeposit,
    stashedColl,
    yieldGainClaimedCum:
      (existing?.yieldGainClaimedCum ?? 0n) + op.yieldGainClaimed,
    ethGainClaimedCum: (existing?.ethGainClaimedCum ?? 0n) + op.ethGainClaimed,
    firstDepositAt:
      existing?.firstDepositAt ?? (newDeposit > 0n ? blockTimestamp : 0n),
    lastUpdatedAt: blockTimestamp,
    cumulativeDeposited:
      (existing?.cumulativeDeposited ?? 0n) +
      (op.topUpOrWithdrawal > 0n ? op.topUpOrWithdrawal : 0n),
    cumulativeWithdrawn:
      (existing?.cumulativeWithdrawn ?? 0n) +
      (op.topUpOrWithdrawal < 0n ? -op.topUpOrWithdrawal : 0n),
  };
}

export function buildStabilityPoolOperationEvent({
  id,
  chainId,
  instanceId,
  depositor,
  newDeposit,
  stashedColl,
  existing,
  pending,
  blockNumber,
  blockTimestamp,
  txHash,
}: {
  id: string;
  chainId: number;
  instanceId: string;
  depositor: string;
  newDeposit: bigint;
  stashedColl: bigint;
  existing: StabilityPoolDepositor | undefined;
  pending: StabilityPoolPendingOperation | undefined;
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: string;
}): StabilityPoolOperationEvent | null {
  if (pending === undefined) return null;
  const op = pending;
  const retainedYield = op.yieldGainSinceLastOperation - op.yieldGainClaimed;
  return {
    id,
    chainId,
    instanceId,
    depositor,
    operation: op.operation,
    depositLossSinceLastOperation: op.depositLossSinceLastOperation,
    topUpOrWithdrawal: op.topUpOrWithdrawal,
    yieldGainSinceLastOperation: op.yieldGainSinceLastOperation,
    yieldGainClaimed: op.yieldGainClaimed,
    ethGainSinceLastOperation: op.ethGainSinceLastOperation,
    ethGainClaimed: op.ethGainClaimed,
    depositBefore:
      newDeposit -
      op.topUpOrWithdrawal -
      retainedYield +
      op.depositLossSinceLastOperation,
    depositAfter: newDeposit,
    stashedCollBefore: existing?.stashedColl ?? 0n,
    stashedCollAfter: stashedColl,
    timestamp: blockTimestamp,
    blockNumber,
    txHash,
  };
}

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
    // Intentionally no isPreload guard: DepositUpdated's preload pass reads
    // this pending row to declare the correct StabilityPoolDepositor dependency.
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
      operation: Number(event.params._operation),
      depositLossSinceLastOperation:
        event.params._depositLossSinceLastOperation,
      topUpOrWithdrawal: event.params._topUpOrWithdrawal,
      yieldGainSinceLastOperation: event.params._yieldGainSinceLastOperation,
      yieldGainClaimed: event.params._yieldGainClaimed,
      ethGainSinceLastOperation: event.params._ethGainSinceLastOperation,
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
    const depositorId = `${collateralId}-${depositor}`;
    const blockTimestamp = asBigInt(event.block.timestamp);
    const blockNumber = asBigInt(event.block.number);
    const pendingKey = pendingDepositKey(
      event.chainId,
      event.transaction.hash,
      collateralId,
      depositor,
    );
    const [existing, pending] = await Promise.all([
      context.StabilityPoolDepositor.get(depositorId),
      context.PendingDepositOperation.get(pendingKey),
    ]);
    if (context.isPreload) return;
    if (pending !== undefined) {
      context.PendingDepositOperation.deleteUnsafe(pendingKey);
    }
    const op =
      pending === undefined
        ? undefined
        : ({
            operation: pending.operation,
            depositLossSinceLastOperation:
              pending.depositLossSinceLastOperation,
            topUpOrWithdrawal: pending.topUpOrWithdrawal,
            yieldGainSinceLastOperation: pending.yieldGainSinceLastOperation,
            yieldGainClaimed: pending.yieldGainClaimed,
            ethGainSinceLastOperation: pending.ethGainSinceLastOperation,
            ethGainClaimed: pending.ethGainClaimed,
          } satisfies StabilityPoolPendingOperation);
    const next = buildStabilityPoolDepositorUpdate({
      chainId: event.chainId,
      collateralId,
      depositor,
      newDeposit: event.params._newDeposit,
      stashedColl: event.params._stashedColl,
      blockTimestamp,
      existing,
      pending: op,
    });
    const operationEvent = buildStabilityPoolOperationEvent({
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      instanceId: collateralId,
      depositor,
      newDeposit: event.params._newDeposit,
      stashedColl: event.params._stashedColl,
      existing,
      pending: op,
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });
    if (operationEvent !== null) {
      context.StabilityPoolOperationEvent.set(operationEvent);
    }
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
        preloadBorrowingRevenueRollover(
          context,
          makeCollateralId(market),
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
    const collateral = await getOrLoadSystemParams(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    instance = (await context.LiquityInstance.get(instance.id)) ?? instance;
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
    context.LiquityInstance.set({
      ...touchLiquityInstance(
        await flushLiquitySnapshots(
          context,
          instance,
          blockTimestamp,
          blockNumber,
        ),
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
