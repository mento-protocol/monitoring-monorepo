import { ERC20_BALANCE_OF_ABI } from "../abis.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { consoleLogger, type RpcLogger } from "./log.js";

const _testStethBalanceOf = new Map<string, bigint | null>();

/** @internal Test-only: mock stETH balanceOf(account) at a block. */
export function _setMockStethBalanceOf({
  chainId,
  tokenAddress,
  account,
  blockNumber,
  value,
}: {
  chainId: number;
  tokenAddress: string;
  account: string;
  blockNumber: bigint;
  value: bigint | null;
}): void {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${account.toLowerCase()}:${blockNumber}`;
  _testStethBalanceOf.set(key, value);
}

/** @internal Test-only: clear mocked stETH balances. */
export function _clearMockStethBalanceOf(): void {
  _testStethBalanceOf.clear();
}

export async function fetchStethBalanceOf(
  {
    chainId,
    tokenAddress,
    account,
    blockNumber,
  }: {
    chainId: number;
    tokenAddress: string;
    account: string;
    blockNumber: bigint;
  },
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${account.toLowerCase()}:${blockNumber}`;
  const mocked = _testStethBalanceOf.get(key);
  if (mocked !== undefined) return mocked;

  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [account as `0x${string}`],
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
      "stethBalanceOf",
      `${tokenAddress}:${account}`,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}
