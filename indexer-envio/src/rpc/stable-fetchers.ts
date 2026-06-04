import { ERC20_BALANCE_OF_ABI, ERC20_TOTAL_SUPPLY_ABI } from "../abis.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { consoleLogger, type RpcLogger } from "./log.js";

const _testTotalSupply = new Map<string, bigint | null>();
const _testBalanceOf = new Map<string, bigint | null>();

/** @internal Test-only: pre-set a mock totalSupply for a token at a block. */
export function _setMockStableTotalSupply(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  value: bigint | null,
): void {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`;
  _testTotalSupply.set(key, value);
}

/** @internal Test-only: clear all mock totalSupply values. */
export function _clearMockStableTotalSupply(): void {
  _testTotalSupply.clear();
}

/** @internal Test-only: pre-set a mock ERC20 balanceOf(account) at a block. */
export function _setMockStableBalanceOf({
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
  _testBalanceOf.set(key, value);
}

/** @internal Test-only: clear all mock balanceOf values. */
export function _clearMockStableBalanceOf(): void {
  _testBalanceOf.clear();
}

/**
 * Returns the on-chain totalSupply for an ERC20 at the given block, or null
 * on RPC failure. Callers must skip the entity write and retry on the next
 * event rather than persist a degraded baseline.
 */
export async function fetchStableTotalSupply(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`;
  const mocked = _testTotalSupply.get(key);
  if (mocked !== undefined) return mocked;
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: ERC20_TOTAL_SUPPLY_ABI,
        functionName: "totalSupply",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return result as bigint;
  } catch (err) {
    if (isContractNotDeployedError(err)) {
      log.info?.(
        `[stableTotalSupply] ${tokenAddress} on chain ${chainId} returned no data at block ${blockNumber} - pre-deployment block, seeding baseline = 0n.`,
      );
      return BigInt(0);
    }
    logRpcFailure(
      chainId,
      "stableTotalSupply",
      tokenAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/**
 * Returns the on-chain ERC20 balanceOf(account) at the given block, or null
 * on RPC failure. Used to seed NTT lock-custody state at `event.block - 1`.
 */
export async function fetchStableBalanceOf(
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
  const mocked = _testBalanceOf.get(key);
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
    if (isContractNotDeployedError(err)) {
      log.info?.(
        `[stableBalanceOf] ${tokenAddress}.balanceOf(${account}) on chain ${chainId} returned no data at block ${blockNumber} - pre-deployment block, seeding baseline = 0n.`,
      );
      return BigInt(0);
    }
    logRpcFailure(
      chainId,
      "stableBalanceOf",
      `${tokenAddress}:${account}`,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

// Mirrors `isUnsupportedGetterError` in pool-fees.ts. viem wraps the
// "returned no data" message when an ERC20 address has no code at the queried
// block.
function isContractNotDeployedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("returned no data");
}
