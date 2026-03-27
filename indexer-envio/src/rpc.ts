// ---------------------------------------------------------------------------
// RPC client management, fetch functions, caches, and test mocks
// ---------------------------------------------------------------------------

import { createPublicClient, http } from "viem";
import type { HandlerContext } from "generated/src/Types";
import type { Pool } from "generated";
import {
  SortedOraclesContract,
  FPMM_MINIMAL_ABI,
  FPMM_TRADING_LIMITS_ABI,
  ERC20_DECIMALS_ABI,
} from "./abis";
import type { TradingLimitData } from "./tradingLimits";

// ---------------------------------------------------------------------------
// RPC failure logging
// ---------------------------------------------------------------------------

/** How many failures of the same (chainId, fn) to accumulate before emitting
 * an additional [RPC_FAILURE_BURST] summary line. Individual failures are
 * always logged; the burst line is the "pattern detected" signal for monitoring. */
const RPC_BURST_INTERVAL = 10;

/** Monotonically increasing failure count per `chainId:fn` key. */
const _rpcFailureCounts = new Map<string, number>();

function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/https?:\/\/[^\s,)""]*/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}/<redacted>`;
    } catch {
      return "<url-redacted>";
    }
  });
}

/**
 * Log a structured RPC failure warning and emit a burst-summary line every
 * `RPC_BURST_INTERVAL` failures for the same chain+function combination.
 */
function logRpcFailure(
  chainId: number,
  fn: string,
  target: string,
  err: unknown,
  block?: bigint,
): void {
  const message =
    err instanceof Error
      ? sanitizeErrorMessage(err.message)
      : String(err ?? "unknown error");
  const blockStr = block !== undefined ? ` block=${block}` : "";
  console.warn(
    `[RPC_FAILURE] chainId=${chainId} fn=${fn} target=${target}${blockStr} error=${message}`,
  );

  const burstKey = `${chainId}:${fn}`;
  const count = (_rpcFailureCounts.get(burstKey) ?? 0) + 1;
  _rpcFailureCounts.set(burstKey, count);
  if (count % RPC_BURST_INTERVAL === 0) {
    console.warn(
      `[RPC_FAILURE_BURST] chainId=${chainId} fn=${fn} failureCount=${count}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test hooks — only used in unit tests to inject mock RPC responses.
// Never set in production; fetch* functions check these maps first.
// ---------------------------------------------------------------------------

const _testRebalancingStates = new Map<string, RebalancingState | null>();

/** @internal Test-only: pre-set a mock rebalancing state for a pool. */
export function _setMockRebalancingState(
  chainId: number,
  poolAddress: string,
  state: RebalancingState | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  if (state === null) {
    _testRebalancingStates.delete(key);
  } else {
    _testRebalancingStates.set(key, state);
  }
}

/** @internal Test-only: clear all mock rebalancing states. */
export function _clearMockRebalancingStates(): void {
  _testRebalancingStates.clear();
}

/** Sentinel value representing a mock null return (RPC failure simulation).
 * Distinct from "no mock set" (which falls through to real RPC). */
const NULL_RESERVES = Symbol("null-reserves");

const _testReserves = new Map<
  string,
  { reserve0: bigint; reserve1: bigint } | typeof NULL_RESERVES
>();

/** @internal Test-only: pre-set mock on-chain reserves for a pool.
 * Pass `null` to simulate an RPC failure (fetchReserves returns null).
 * Call `_clearMockReserves()` to remove all mocks and restore real RPC. */
export function _setMockReserves(
  chainId: number,
  poolAddress: string,
  reserves: { reserve0: bigint; reserve1: bigint } | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  _testReserves.set(key, reserves === null ? NULL_RESERVES : reserves);
}

/** @internal Test-only: clear all mock reserves. */
export function _clearMockReserves(): void {
  _testReserves.clear();
}

/** @internal Test-only: pre-set mock ERC20 decimals for a token address. */
const _testERC20Decimals = new Map<string, number>();

export function _setMockERC20Decimals(
  chainId: number,
  tokenAddress: string,
  decimals: number,
): void {
  _testERC20Decimals.set(`${chainId}:${tokenAddress.toLowerCase()}`, decimals);
}

export function _clearMockERC20Decimals(): void {
  _testERC20Decimals.clear();
}

// ---------------------------------------------------------------------------
// Test mocks: referenceRateFeedID & reportExpiry (for self-heal testing)
// ---------------------------------------------------------------------------

const _testRateFeedIDs = new Map<string, string | null>();

/** @internal Test-only: pre-set a mock referenceRateFeedID for a pool. */
export function _setMockRateFeedID(
  chainId: number,
  poolAddress: string,
  rateFeedID: string | null,
): void {
  _testRateFeedIDs.set(`${chainId}:${poolAddress.toLowerCase()}`, rateFeedID);
}

export function _clearMockRateFeedIDs(): void {
  _testRateFeedIDs.clear();
}

const _testReportExpiry = new Map<string, bigint | null>();

/** @internal Test-only: pre-set a mock report expiry for a rateFeedID. */
export function _setMockReportExpiry(
  chainId: number,
  rateFeedID: string,
  expiry: bigint | null,
): void {
  _testReportExpiry.set(`${chainId}:${rateFeedID.toLowerCase()}`, expiry);
}

export function _clearMockReportExpiry(): void {
  _testReportExpiry.clear();
}

// ---------------------------------------------------------------------------
// RPC client management
// ---------------------------------------------------------------------------

// Lazy RPC clients per chainId
const rpcClients = new Map<number, ReturnType<typeof createPublicClient>>();

// Per-chain RPC defaults. ENVIO_RPC_URL overrides the default for the active chain.
const DEFAULT_RPC_BY_CHAIN: Record<number, string> = {
  42220: "https://forno.celo.org", // Celo Mainnet
  11142220: "https://forno.celo-sepolia.celo-testnet.org", // Celo Sepolia
  143: "https://rpc2.monad.xyz", // Monad Mainnet
  10143: "https://10143.rpc.hypersync.xyz", // Monad Testnet (Envio HyperRPC)
};

export function getRpcClient(
  chainId: number,
): ReturnType<typeof createPublicClient> {
  if (!rpcClients.has(chainId)) {
    const defaultRpc = DEFAULT_RPC_BY_CHAIN[chainId];
    if (!defaultRpc) {
      throw new Error(
        `[getRpcClient] No default RPC configured for chainId ${chainId}. ` +
          `Add an entry to DEFAULT_RPC_BY_CHAIN in rpc.ts.`,
      );
    }
    rpcClients.set(
      chainId,
      createPublicClient({
        transport: http(process.env.ENVIO_RPC_URL ?? defaultRpc, {
          batch: true,
        }),
      }),
    );
  }
  return rpcClients.get(chainId)!;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RebalancingState = {
  oraclePriceNumerator: bigint;
  oraclePriceDenominator: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Returns SortedOracles address for chainId, throws if not in @mento-protocol/contracts. */
const SORTED_ORACLES_ADDRESS = SortedOraclesContract.address;

/** Cache numRates by block — numRates can't change within a single block.
 * Key: "chainId:feedId:blockNumber" */
const numReportersCache = new Map<string, number>();

/** Cache report expiry per feed.
 * Key: "chainId:feedId:blockNumber" — including blockNumber ensures historical
 * backfills that span a governance change pick up the correct value. */
const reportExpiryCache = new Map<string, bigint>();

/** Cache getReserves() results by block — reserves are block-final.
 * Key: "chainId:poolAddress:blockNumber"
 * Evicted when a new blockNumber is seen (Envio processes blocks sequentially). */
const reservesCache = new Map<string, { reserve0: bigint; reserve1: bigint }>();
let reservesCacheLastBlock: bigint | undefined;

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

export async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  blockNumber?: bigint,
): Promise<RebalancingState | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "getRebalancingState",
      ...(blockNumber !== undefined && { blockNumber }),
    });
    const r = result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      number,
      bigint,
    ];
    return {
      oraclePriceNumerator: r[0],
      oraclePriceDenominator: r[1],
      rebalanceThreshold: Number(r[5]),
      priceDifference: r[6],
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "getRebalancingState",
      poolAddress,
      err,
      blockNumber,
    );
    return null;
  }
}

/**
 * Fetch current on-chain reserves for a pool via getReserves().
 * Returns null on RPC failure so callers preserve stale reserves.
 */
export async function fetchReserves(
  chainId: number,
  poolAddress: string,
  blockNumber?: bigint,
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testReserves.has(testKey)) {
    const mock = _testReserves.get(testKey);
    return mock === NULL_RESERVES ? null : (mock ?? null);
  }

  // Block-scoped cache: evict stale entries when a new block is encountered.
  if (blockNumber !== undefined && blockNumber !== reservesCacheLastBlock) {
    reservesCache.clear();
    reservesCacheLastBlock = blockNumber;
  }
  const cacheKey = `${chainId}:${poolAddress.toLowerCase()}:${blockNumber}`;
  const cached = reservesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "getReserves",
      ...(blockNumber !== undefined && { blockNumber }),
    });
    const r = result as readonly [bigint, bigint, bigint];
    const reserves = { reserve0: r[0], reserve1: r[1] };
    reservesCache.set(cacheKey, reserves);
    return reserves;
  } catch (err) {
    logRpcFailure(chainId, "getReserves", poolAddress, err, blockNumber);
    return null;
  }
}

/** Fetch the pool's invertRateFeed flag. Returns false on error (default). */
export async function fetchInvertRateFeed(
  chainId: number,
  poolAddress: string,
): Promise<boolean> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "invertRateFeed",
    });
    return result as boolean;
  } catch (err) {
    logRpcFailure(chainId, "invertRateFeed", poolAddress, err);
    return false;
  }
}

/** Fetch the pool's rebalance threshold using standalone getters that do NOT
 * require the oracle to be live (unlike getRebalancingState which reverts when
 * the oracle is stale). Returns the max of thresholdAbove/thresholdBelow, or 0. */
export async function fetchRebalanceThreshold(
  chainId: number,
  poolAddress: string,
): Promise<number> {
  try {
    const client = getRpcClient(chainId);
    const [above, below] = await Promise.all([
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdAbove",
      }),
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdBelow",
      }),
    ]);
    return Math.max(Number(above), Number(below));
  } catch (err) {
    logRpcFailure(chainId, "rebalanceThreshold", poolAddress, err);
    return 0;
  }
}

export async function fetchReferenceRateFeedID(
  chainId: number,
  poolAddress: string,
): Promise<string | null> {
  const mockKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRateFeedIDs.has(mockKey)) return _testRateFeedIDs.get(mockKey)!;

  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "referenceRateFeedID",
    });
    return (result as string).toLowerCase();
  } catch (err) {
    logRpcFailure(chainId, "referenceRateFeedID", poolAddress, err);
    return null;
  }
}

/** Returns the number of active oracle reporters for the given rateFeedID at
 * the given block, or null on error. Results are cached per block. */
export async function fetchNumReporters(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<number | null> {
  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }

  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = numReportersCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const count = await client.readContract({
      address,
      abi: SortedOraclesContract.abi,
      functionName: "numRates",
      args: [rateFeedID as `0x${string}`],
      blockNumber,
    });
    const value = Number(count);
    numReportersCache.set(cacheKey, value);
    return value;
  } catch (err) {
    logRpcFailure(chainId, "numRates", rateFeedID, err, blockNumber);
    return null;
  }
}

/** Returns the effective oracle report expiry (seconds) for the given rateFeedID.
 * Returns null on RPC/address error so callers can preserve the previous known-good value. */
export async function fetchReportExpiry(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<bigint | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testReportExpiry.has(mockKey)) return _testReportExpiry.get(mockKey)!;

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }

  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = reportExpiryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const tokenExpiry = (await client.readContract({
      address,
      abi: SortedOraclesContract.abi,
      functionName: "tokenReportExpirySeconds",
      args: [rateFeedID as `0x${string}`],
      blockNumber,
    })) as bigint;
    const expiry: bigint =
      tokenExpiry > 0n
        ? tokenExpiry
        : ((await client.readContract({
            address,
            abi: SortedOraclesContract.abi,
            functionName: "reportExpirySeconds",
            blockNumber,
          })) as bigint);
    if (expiry <= 0n) return null;
    reportExpiryCache.set(cacheKey, expiry);
    return expiry;
  } catch (err) {
    logRpcFailure(chainId, "reportExpiry", rateFeedID, err, blockNumber);
    return null;
  }
}

/** Fetches decimals0() or decimals1() from an FPMM pool — returns the scaling
 *  factor (e.g. 1000000000000000000n for 18dp, 1000000n for 6dp).
 *  Falls back to calling ERC20 decimals() on the token contract if the pool
 *  method fails. */
export async function fetchTokenDecimalsScaling(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
  fallbackTokenAddress?: string,
): Promise<bigint | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: fn,
    });
    return result as bigint;
  } catch (err) {
    logRpcFailure(chainId, fn, poolAddress, err);
    if (!fallbackTokenAddress) return null;
    const erc20Key = `${chainId}:${fallbackTokenAddress.toLowerCase()}`;
    if (_testERC20Decimals.has(erc20Key)) {
      const d = _testERC20Decimals.get(erc20Key)!;
      return 10n ** BigInt(d);
    }
    try {
      const client = getRpcClient(chainId);
      const d = await client.readContract({
        address: fallbackTokenAddress as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      });
      const decimals = Number(d);
      if (decimals < 0 || decimals > 36) return null;
      return 10n ** BigInt(decimals);
    } catch (err) {
      logRpcFailure(chainId, "erc20Decimals", fallbackTokenAddress, err);
      return null;
    }
  }
}

export async function fetchTradingLimits(
  chainId: number,
  poolAddress: string,
  token: string,
): Promise<TradingLimitData | null> {
  try {
    const client = getRpcClient(chainId);
    const result = (await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_TRADING_LIMITS_ABI,
      functionName: "getTradingLimits",
      args: [token as `0x${string}`],
    })) as unknown as [
      { limit0: bigint; limit1: bigint; decimals: number },
      {
        lastUpdated0: number;
        lastUpdated1: number;
        netflow0: bigint;
        netflow1: bigint;
      },
    ];
    const [config, state] = result;
    return { config, state };
  } catch (err) {
    logRpcFailure(chainId, "getTradingLimits", poolAddress, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Oracle DB query helpers (used by SortedOracles handlers)
// ---------------------------------------------------------------------------

/** Returns all FPMM pool IDs on the given chain that reference the given rateFeedID.
 * Uses context.Pool.getWhere (DB-backed) so it works correctly in Envio's
 * multi-process hosted environment.
 *
 * NOTE — in-memory chainId filter: Envio's getWhere only supports single-field
 * queries, so there is no compound "referenceRateFeedID + chainId" DB query.
 * We fetch all pools with the matching feedId across all chains and filter
 * locally. This is correct and safe: each oracle feed maps to at most ~4 FPMM
 * pools total across both chains, so the result set is always tiny. Do NOT
 * "simplify" this to a DB query — the API does not support it. */
export async function getPoolsByFeed(
  context: HandlerContext,
  chainId: number,
  rateFeedID: string,
): Promise<string[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.eq(rateFeedID);
  return pools.filter((p) => p.chainId === chainId).map((p) => p.id);
}

export async function updatePoolsOracleExpiry(
  context: HandlerContext,
  poolIds: string[],
  oracleExpiry: bigint | null,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (oracleExpiry === null || poolIds.length === 0) return;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing || existing.oracleExpiry === oracleExpiry) continue;

    const updatedPool: Pool = {
      ...existing,
      oracleExpiry,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.Pool.set(updatedPool);
  }
}

/** Same in-memory filter rationale as getPoolsByFeed above — Envio getWhere is
 * single-field only, so we fetch all pools with a non-empty referenceRateFeedID
 * and filter by chainId locally. Result set is always small. */
export async function getPoolsWithReferenceFeed(
  context: HandlerContext,
  chainId: number,
): Promise<Pool[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.gt("");
  return pools.filter((p) => p.chainId === chainId);
}
