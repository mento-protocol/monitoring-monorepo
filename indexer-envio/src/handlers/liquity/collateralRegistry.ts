import { indexer } from "../../indexer.js";
import { asAddress, asBigInt } from "../../helpers.js";
import { getOrCreateLiquityInstance } from "./bootstrap.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { toBpsFromD18 } from "./math.js";

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
      baseRate: event.params._baseRate,
      currentRedemptionRateBps: toBpsFromD18(event.params._baseRate),
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
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const existing = await context.LiquityCollateral.get(
      makeCollateralId(market),
    );
    if (existing !== undefined) {
      context.LiquityCollateral.set({
        ...existing,
        collateralRegistry: asAddress(event.srcAddress),
      });
    }
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
