import { indexer } from "../../indexer.js";
import { asBigInt } from "../../helpers.js";
import {
  getOrCreateLiquityInstance,
  preloadLiquityMarket,
} from "./bootstrap.js";
import { findLiquityMarketByEventSource } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { toBpsFromD18 } from "./math.js";
import { getOrLoadSystemParams, preloadSystemParams } from "./systemParams.js";

indexer.contractRegister(
  { contract: "LiquityCollateralRegistry", event: "LiquidityStrategyUpdated" },
  async ({ event, context }) => {
    context.chain.CDPLiquidityStrategy.add(event.params._liquidityStrategy);
  },
);

indexer.onEvent(
  { contract: "LiquityCollateralRegistry", event: "BaseRateUpdated" },
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
    const baseRateBps = toBpsFromD18(event.params._baseRate);
    context.LiquityInstance.set({
      ...next,
      baseRate: event.params._baseRate,
      currentRedemptionRateBps:
        collateral?.systemParamsLoaded === true
          ? baseRateBps + collateral.redemptionFeeFloorBps
          : -1,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityCollateralRegistry", event: "LastFeeOpTimeUpdated" },
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
    const next = touchLiquityInstance(
      flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
      blockNumber,
      blockTimestamp,
    );
    context.LiquityInstance.set({
      ...next,
      lastFeeOpTime: event.params._lastFeeOpTime,
    });
  },
);

indexer.onEvent(
  { contract: "LiquityCollateralRegistry", event: "LiquidityStrategyUpdated" },
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
    context.LiquityInstance.set(
      touchLiquityInstance(
        flushLiquitySnapshots(context, instance, blockTimestamp, blockNumber),
        blockNumber,
        blockTimestamp,
      ),
    );
  },
);
