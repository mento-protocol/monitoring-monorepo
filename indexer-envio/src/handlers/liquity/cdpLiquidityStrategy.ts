import { indexer } from "../../indexer.js";
import { asAddress, asBigInt, eventId, makePoolId } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { preloadBorrowingRevenueRollover } from "./borrowingRevenue.js";
import {
  findCollateralIdByPoolFallback,
  findLiquityMarketByDebtToken,
  makeCollateralId,
  marketByCollateralId,
} from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";

indexer.onEvent(
  { contract: "CDPLiquidityStrategy", event: "PoolAdded" },
  async ({ event, context }) => {
    const poolAddress = asAddress(event.params.pool);
    const poolId = makePoolId(event.chainId, poolAddress);
    const params = event.params.params;
    const market = findLiquityMarketByDebtToken(
      event.chainId,
      params.debtToken,
    );
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    context.CdpPool.set({
      id: poolId,
      chainId: event.chainId,
      collateralId: market === undefined ? undefined : makeCollateralId(market),
      debtToken: asAddress(params.debtToken),
      poolId,
      strategyAddress: asAddress(event.srcAddress),
      rebalanceCooldownSec: Number(params.cooldown),
      addedAtBlock: blockNumber,
      addedAtTimestamp: blockTimestamp,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
      removed: false,
    });
  },
);

indexer.onEvent(
  { contract: "CDPLiquidityStrategy", event: "PoolRemoved" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.params.pool);
    const existing = await context.CdpPool.get(poolId);
    if (context.isPreload) return;
    if (existing === undefined) return;
    context.CdpPool.set({
      ...existing,
      removed: true,
      updatedAtBlock: asBigInt(event.block.number),
      updatedAtTimestamp: asBigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "CDPLiquidityStrategy", event: "RebalanceCooldownSet" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.params.pool);
    const existing = await context.CdpPool.get(poolId);
    if (context.isPreload) return;
    if (existing === undefined) return;
    context.CdpPool.set({
      ...existing,
      rebalanceCooldownSec: Number(event.params.cooldown),
      updatedAtBlock: asBigInt(event.block.number),
      updatedAtTimestamp: asBigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "CDPLiquidityStrategy", event: "LiquidityMoved" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.params.pool);
    if (context.isPreload) {
      await context.CdpPool.get(poolId);
      return;
    }
    context.CdpLiquidityMove.set({
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      poolId,
      direction: Number(event.params.direction),
      tokenGivenToPool: asAddress(event.params.tokenGivenToPool),
      amountGivenToPool: event.params.amountGivenToPool,
      tokenTakenFromPool: asAddress(event.params.tokenTakenFromPool),
      amountTakenFromPool: event.params.amountTakenFromPool,
      timestamp: asBigInt(event.block.timestamp),
      blockNumber: asBigInt(event.block.number),
      txHash: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "CDPLiquidityStrategy", event: "RedemptionShortfallSubsidized" },
  async ({ event, context }) => {
    const poolAddress = asAddress(event.params.pool);
    const poolId = makePoolId(event.chainId, poolAddress);
    const existing = await context.CdpPool.get(poolId);
    const collateralId =
      existing?.collateralId ??
      findCollateralIdByPoolFallback(event.chainId, poolAddress);
    if (collateralId === undefined) return;
    const market = marketByCollateralId.get(collateralId);
    if (market === undefined) return;
    if (context.isPreload) {
      await preloadLiquityMarket(context, market);
      await preloadBorrowingRevenueRollover(
        context,
        collateralId,
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
      shortfallSubsidyCum: next.shortfallSubsidyCum + event.params.shortfall,
      shortfallSubsidyBucket:
        next.shortfallSubsidyBucket + event.params.shortfall,
      shortfallSubsidyDayBucket:
        next.shortfallSubsidyDayBucket + event.params.shortfall,
    });
  },
);
