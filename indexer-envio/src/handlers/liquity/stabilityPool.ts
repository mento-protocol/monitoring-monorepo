import type { StabilityPoolDepositor } from "envio";
import { indexer } from "../../indexer.js";
import { asAddress, asBigInt, eventId } from "../../helpers.js";
import { getOrCreateLiquityInstance } from "./bootstrap.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";

const OP_BY_DEPOSITOR = new Map<
  string,
  {
    topUpOrWithdrawal: bigint;
    yieldGainClaimed: bigint;
    ethGainClaimed: bigint;
  }
>();

const pendingDepositKey = (
  chainId: number,
  txHash: string,
  depositor: string,
): string => `${chainId}-${txHash}-${asAddress(depositor)}`;

indexer.onEvent(
  { contract: "LiquityStabilityPool", event: "DepositOperation" },
  async ({ event }) => {
    OP_BY_DEPOSITOR.set(
      pendingDepositKey(
        event.chainId,
        event.transaction.hash,
        event.params._depositor,
      ),
      {
        topUpOrWithdrawal: event.params._topUpOrWithdrawal,
        yieldGainClaimed: event.params._yieldGainClaimed,
        ethGainClaimed: event.params._ethGainClaimed,
      },
    );
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
    const existing = await context.StabilityPoolDepositor.get(id);
    const pendingKey = pendingDepositKey(
      event.chainId,
      event.transaction.hash,
      depositor,
    );
    const pending = OP_BY_DEPOSITOR.get(pendingKey);
    OP_BY_DEPOSITOR.delete(pendingKey);
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
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const instance = await getOrCreateLiquityInstance(
      context,
      market,
      blockNumber,
      blockTimestamp,
    );
    const collateral = await context.LiquityCollateral.get(
      makeCollateralId(market),
    );
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
