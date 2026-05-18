import { indexer } from "../../indexer.js";
import { asBigInt } from "../../helpers.js";
import { getOrCreateLiquityInstance } from "./bootstrap.js";
import { findLiquityMarketByEventSource } from "./config.js";
import { flushLiquitySnapshots, touchLiquityInstance } from "./instance.js";
import { toBpsFromD18 } from "./math.js";

indexer.onEvent(
  { contract: "LiquityBorrowerOperations", event: "ShutDown" },
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
      isShutDown: true,
      shutDownAt: blockTimestamp,
      shutDownTcrBps: toBpsFromD18(event.params._tcr),
    });
  },
);
