import type { Logger } from "envio";
import { createEffect, S } from "envio";
import fxPriceFeedAbi from "../../../abis/liquity/FXPriceFeed.json" with { type: "json" };
import {
  getFallbackRpcClient,
  getRpcClient,
  logRpcFailure,
  readContractWithBlockFallback,
} from "../../rpc.js";
import { trackEffectExecution } from "../../performance.js";
import type { LiquityMarketConfig } from "./config.js";

async function fetchLiquityPrice(
  chainId: number,
  priceFeed: string,
  blockNumber: bigint,
  log: Logger,
): Promise<bigint | null> {
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: priceFeed as `0x${string}`,
        abi: fxPriceFeedAbi,
        functionName: "fetchPrice",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback || typeof result !== "bigint") return null;
    return result;
  } catch (err) {
    logRpcFailure(
      chainId,
      "liquityFetchPrice",
      priceFeed,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

const liquityPriceFeedEffect = createEffect(
  {
    name: "liquityPriceFeed",
    input: {
      chainId: S.int32,
      priceFeed: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 100, per: "second" },
    cache: false,
  },
  async ({ input, context }) =>
    (await trackEffectExecution("liquityPriceFeed", () =>
      fetchLiquityPrice(
        input.chainId,
        input.priceFeed,
        input.blockNumber,
        context.log,
      ),
    )) ?? null,
);

export type LiquityPriceContext = {
  effect: (
    effect: typeof liquityPriceFeedEffect,
    input: { chainId: number; priceFeed: string; blockNumber: bigint },
  ) => Promise<bigint | null>;
};

export async function loadLiquityPrice(
  context: LiquityPriceContext,
  market: LiquityMarketConfig,
  blockNumber: bigint,
): Promise<bigint | null> {
  return await context.effect(liquityPriceFeedEffect, {
    chainId: market.chainId,
    priceFeed: market.priceFeed,
    blockNumber,
  });
}
