import { SUSDS_CONVERT_TO_ASSETS_ABI } from "../abis.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import {
  clearSusdsSharePriceHttpMocks,
  registerMockSusdsSharePriceHttp,
} from "./http-test-mock-bridge.js";
import { consoleLogger, type RpcLogger } from "./log.js";

const ONE_SHARE = 10n ** 18n;
const _testSharePrice = new Map<string, bigint | null>();

/** @internal Test-only: mock sUSDS convertToAssets(1e18) at a block. */
export function _setMockSusdsSharePrice(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  value: bigint | null,
): void {
  _testSharePrice.set(
    `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`,
    value,
  );
  registerMockSusdsSharePriceHttp(chainId, tokenAddress, value);
}

/** @internal Test-only: clear mocked sUSDS share prices. */
export function _clearMockSusdsSharePrices(): void {
  _testSharePrice.clear();
  clearSusdsSharePriceHttpMocks();
}

export async function fetchSusdsSharePriceUsdWei(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`;
  const mocked = _testSharePrice.get(key);
  if (mocked !== undefined) return mocked;

  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: SUSDS_CONVERT_TO_ASSETS_ABI,
        functionName: "convertToAssets",
        args: [ONE_SHARE],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return result as bigint;
  } catch (err) {
    logRpcFailure(
      chainId,
      "susdsConvertToAssets",
      tokenAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}
