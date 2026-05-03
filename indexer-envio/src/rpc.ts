// ---------------------------------------------------------------------------
// Pool/oracle/breaker fetchers + caches + test mocks. Client management,
// structured failure logging, and rate-limit detection live in `./rpc/client`.
// ---------------------------------------------------------------------------

import { createPublicClient } from "viem";
import type { HandlerContext } from "generated/src/Types";
import type { Pool, BreakerConfig } from "generated";
import {
  SortedOraclesContract,
  FPMM_MINIMAL_ABI,
  FPMM_FEE_ABI,
  FPMM_TRADING_LIMITS_ABI,
  ERC20_DECIMALS_ABI,
  BREAKER_BOX_ABI,
  MEDIAN_DELTA_BREAKER_ABI,
  VALUE_DELTA_BREAKER_ABI,
} from "./abis";
import { requireContractAddress } from "./contractAddresses";
import type { TradingLimitData } from "./tradingLimits";
import {
  getFallbackRpcClient,
  getRpcClient,
  logRpcFailure,
} from "./rpc/client";
import {
  readContractWithBlockFallback,
  type BlockFallbackResult,
} from "./rpc/block-fallback";

// Re-export the client/log/rate-limit primitives so existing callers
// (feeToken.ts, EventHandlers.ts, breakers.ts, hyperRpcToken.test.ts, etc.)
// that import from "./rpc" continue to work after the split.
export {
  getRpcClient,
  withHyperRpcToken,
  _clearRpcClients,
  _setRpcClientForTests,
} from "./rpc/client";
export {
  readContractWithBlockFallback,
  _testHooks,
} from "./rpc/block-fallback";
export type { BlockFallbackResult } from "./rpc/block-fallback";

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

/** Per-getter mock behavior for fetchFees. */
export type FeeGetterMock =
  | { fulfilled: bigint }
  /** Simulate a transient RPC failure — pool.ts self-heal will retry. */
  | { rejected: "transient" }
  /** Simulate the viem "returned no data (0x)" error that fires when a
   *  getter isn't in the contract bytecode — pool.ts self-heal stamps -2
   *  and stops retrying that field. */
  | { rejected: "unsupported" };

export type FetchFeesMock = {
  lpFee?: FeeGetterMock;
  protocolFee?: FeeGetterMock;
  rebalanceReward?: FeeGetterMock;
  /** Simulate getRpcClient throwing (unknown chain / missing token). */
  rpcClientThrows?: true;
};

const _testFees = new Map<string, FetchFeesMock>();

/** @internal Test-only: override fetchFees' three readContract calls for a
 *  (chain, pool) pair. Pass `null` to clear a specific entry. */
export function _setMockFees(
  chainId: number,
  poolAddress: string,
  mock: FetchFeesMock | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  if (mock === null) {
    _testFees.delete(key);
  } else {
    _testFees.set(key, mock);
  }
}

/** @internal Test-only: clear all fetchFees mocks. */
export function _clearMockFees(): void {
  _testFees.clear();
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

/** Per-chain block-scoped caches. Each cache holds entries for the most
 * recently seen block on each chain — when a chain advances to a new block,
 * its prior entries are evicted. Per-chain (rather than global) eviction is
 * required because the multichain configs run with `unordered_multichain_mode:
 * true`, so events from different chains can interleave at independent block
 * heights. Cardinality is bounded by `chains × keys_per_block`.
 *
 * Per-block keying remains correct for historical backfills (e.g. across an
 * oracle governance change): each fetch is keyed by its own blockNumber, so a
 * cached value can never be returned for a different block. */

/** Cache numRates: "chainId:feedId:blockNumber" → count. */
const numReportersCache = new Map<string, number>();
const numReportersCacheLastBlocks = new Map<number, bigint>();

/** Cache report expiry: "chainId:feedId:blockNumber" → expiry seconds. */
const reportExpiryCache = new Map<string, bigint>();
const reportExpiryCacheLastBlocks = new Map<number, bigint>();

/** Cache getReserves(): "chainId:poolAddress:blockNumber" → reserves. */
const reservesCache = new Map<string, { reserve0: bigint; reserve1: bigint }>();
const reservesCacheLastBlocks = new Map<number, bigint>();

/** Evict any entries for the given chain whose block doesn't match `blockNumber`.
 * Caller passes the cache and its per-chain lastBlocks tracker; we delete
 * entries with the `${chainId}:` prefix when the chain has advanced.
 * Exported under `_evictCacheForChain` for unit testing. */
function evictCacheForChain<T>(
  cache: Map<string, T>,
  lastBlocks: Map<number, bigint>,
  chainId: number,
  blockNumber: bigint,
): void {
  if (lastBlocks.get(chainId) === blockNumber) return;
  const prefix = `${chainId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  lastBlocks.set(chainId, blockNumber);
}

/** @internal Test-only: pure helper for unit-testing the eviction logic. */
export const _evictCacheForChain = evictCacheForChain;

/** @internal Test-only: snapshot block-scoped cache sizes for invariant
 * assertions. Caches are bounded by chains × keys-per-block; tests can drive
 * the fetchers across many blocks and assert the size never explodes. */
export function _getOracleCacheStats(): {
  numReporters: number;
  reportExpiry: number;
  reserves: number;
} {
  return {
    numReporters: numReportersCache.size,
    reportExpiry: reportExpiryCache.size,
    reserves: reservesCache.size,
  };
}

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

function parseRebalancingState(result: unknown): RebalancingState {
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
}

// Memoize `fetchRebalancingState` per (chainId, addr, blockNumber). FPMM
// emits 2× UR + 1× Rebalanced in the same rebalance tx → without this
// cache each handler re-RPCs for identical block state.
//
// Two important invariants (mirrors `fetchReserves` / `fetchReportExpiry`):
// 1. Only cache `usedFallback=false` results. If the request fell back
//    to `latest` (e.g. requested block not yet available), the response
//    isn't actually scoped to the cache key's blockNumber, so caching
//    it would serve stale-across-block data to later callers.
// 2. Only cache non-null results. A null means the RPC failed; a retry
//    next time is cheaper than serving the failure forever.
const REBALANCING_STATE_CACHE_MAX = 256;
const _rebalancingStateCache = new Map<
  string,
  Promise<RebalancingState | null>
>();

function rebalancingCacheKey(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
): string {
  return `${chainId}:${poolAddress.toLowerCase()}:${blockNumber}`;
}

export async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  // `blockNumber` is required so the memoization key is always
  // block-scoped. Previously optional — an undefined caller would have
  // cached a `latest` response under a "latest" key, serving stale state
  // across wall-clock time to later callers.
  blockNumber: bigint,
): Promise<RebalancingState | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }

  const cacheKey = rebalancingCacheKey(chainId, poolAddress, blockNumber);
  const cached = _rebalancingStateCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh LRU position.
    _rebalancingStateCache.delete(cacheKey);
    _rebalancingStateCache.set(cacheKey, cached);
    return cached;
  }

  // Capture usedFallback + null from inside the closure so the outer
  // code can decide whether to cache. Storing the promise (not the
  // resolved value) is critical — concurrent callers share the flight.
  let cachedFallback = false;
  let cachedNull = false;
  const promise = (async (): Promise<RebalancingState | null> => {
    try {
      const client = getRpcClient(chainId);
      const { result, usedFallback } = await readContractWithBlockFallback(
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_MINIMAL_ABI,
          functionName: "getRebalancingState",
        },
        blockNumber,
        getFallbackRpcClient(chainId),
      );
      if (usedFallback) cachedFallback = true;
      return parseRebalancingState(result);
    } catch (err) {
      logRpcFailure(
        chainId,
        "getRebalancingState",
        poolAddress,
        err,
        blockNumber,
      );
      cachedNull = true;
      return null;
    }
  })();

  _rebalancingStateCache.set(cacheKey, promise);
  if (_rebalancingStateCache.size > REBALANCING_STATE_CACHE_MAX) {
    const oldestKey = _rebalancingStateCache.keys().next().value;
    if (oldestKey !== undefined) _rebalancingStateCache.delete(oldestKey);
  }
  // After the flight resolves, evict if the response is not a
  // block-scoped hit. In-flight dedup still works (concurrent callers
  // awaited the same promise); only LATER callers need a fresh attempt.
  promise.finally(() => {
    if (cachedFallback || cachedNull) {
      _rebalancingStateCache.delete(cacheKey);
    }
  });
  return promise;
}

/** Test-only cache reset — lets unit tests start from a clean slate. */
export function _resetRebalancingStateCacheForTests(): void {
  _rebalancingStateCache.clear();
}

/**
 * Fetch current on-chain reserves for a pool via getReserves().
 * Returns null on RPC failure so callers preserve stale reserves.
 *
 * When `blockNumber` is provided and the archive node falls back to
 * `latest` (retries exhausted on the historical block), this returns
 * null rather than the latest reserves — historical-scoped callers
 * (e.g. rebalance delta computation) need to detect the failure
 * instead of being silently fed `latest` data masquerading as the
 * requested block. Callers that want best-effort latest can omit
 * `blockNumber`.
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

  if (blockNumber !== undefined) {
    evictCacheForChain(
      reservesCache,
      reservesCacheLastBlocks,
      chainId,
      blockNumber,
    );
  }
  const cacheKey = `${chainId}:${poolAddress.toLowerCase()}:${blockNumber}`;
  const cached = reservesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const { result, usedFallback, usedLatestFallback } =
      await readContractWithBlockFallback(
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_MINIMAL_ABI,
          functionName: "getReserves",
        },
        blockNumber,
        getFallbackRpcClient(chainId),
      );
    // Only the `latest`-block fallback breaks the historical-accuracy
    // guarantee callers rely on. Secondary-RPC fallback still queries
    // the requested block, so its result is fine to return.
    if (usedLatestFallback) {
      return null;
    }
    const r = result as readonly [bigint, bigint, bigint];
    const reserves = { reserve0: r[0], reserve1: r[1] };
    if (!usedFallback) {
      reservesCache.set(cacheKey, reserves);
    }
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

  evictCacheForChain(
    numReportersCache,
    numReportersCacheLastBlocks,
    chainId,
    blockNumber,
  );
  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = numReportersCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const { result, usedFallback } = await readContractWithBlockFallback(
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "numRates",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    const value = Number(result);
    if (!usedFallback) {
      numReportersCache.set(cacheKey, value);
    }
    return value;
  } catch (err) {
    logRpcFailure(chainId, "numRates", rateFeedID, err, blockNumber);
    return null;
  }
}

// In-flight dedup for `fetchReportExpiry`. The value-level `reportExpiryCache`
// is populated only AFTER the RPC resolves, so under `Promise.all` fan-out
// (oracle handlers parallelize per pool — pools sharing a feed fire
// identical requests concurrently) every caller misses and re-RPCs. This
// Promise map collapses in-flight requests: concurrent callers share one
// flight, the value cache then absorbs subsequent calls. Entries are
// cleared on resolve (win + loss) so the value cache / retry path
// takes over afterwards.
const _reportExpiryInFlight = new Map<string, Promise<bigint | null>>();

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

  evictCacheForChain(
    reportExpiryCache,
    reportExpiryCacheLastBlocks,
    chainId,
    blockNumber,
  );
  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = reportExpiryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const inFlight = _reportExpiryInFlight.get(cacheKey);
  if (inFlight !== undefined) return inFlight;

  const promise = (async (): Promise<bigint | null> => {
    try {
      const client = getRpcClient(chainId);
      let usedAnyFallback = false;
      const tokenExpiryRes = await readContractWithBlockFallback(
        client,
        {
          address,
          abi: SortedOraclesContract.abi,
          functionName: "tokenReportExpirySeconds",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        getFallbackRpcClient(chainId),
      );
      if (tokenExpiryRes.usedFallback) usedAnyFallback = true;
      const tokenExpiry = tokenExpiryRes.result as bigint;
      let expiry: bigint;
      if (tokenExpiry > 0n) {
        expiry = tokenExpiry;
      } else {
        const globalRes = await readContractWithBlockFallback(
          client,
          {
            address,
            abi: SortedOraclesContract.abi,
            functionName: "reportExpirySeconds",
          },
          blockNumber,
          getFallbackRpcClient(chainId),
        );
        if (globalRes.usedFallback) usedAnyFallback = true;
        expiry = globalRes.result as bigint;
      }
      if (expiry <= 0n) return null;
      if (!usedAnyFallback) {
        reportExpiryCache.set(cacheKey, expiry);
      }
      return expiry;
    } catch (err) {
      logRpcFailure(chainId, "reportExpiry", rateFeedID, err, blockNumber);
      return null;
    }
  })();

  _reportExpiryInFlight.set(cacheKey, promise);
  promise.finally(() => {
    _reportExpiryInFlight.delete(cacheKey);
  });
  return promise;
}

/** Test-only: clear the in-flight `fetchReportExpiry` map. */
export function _resetReportExpiryInFlightForTests(): void {
  _reportExpiryInFlight.clear();
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
  blockNumber?: bigint,
): Promise<TradingLimitData | null> {
  try {
    const client = getRpcClient(chainId);
    const { result: raw } = await readContractWithBlockFallback(
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_TRADING_LIMITS_ABI,
        functionName: "getTradingLimits",
        args: [token as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    const result = raw as unknown as [
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
    logRpcFailure(chainId, "getTradingLimits", poolAddress, err, blockNumber);
    return null;
  }
}

/** viem's `ContractFunctionZeroDataError` (message includes "returned no
 *  data") fires when the called function isn't in the contract bytecode —
 *  distinct from a network / RPC timeout. For fee getters that's the
 *  "older FPMM, getter missing" path, and pool.ts uses -2 to stamp those
 *  fields so self-heal stops retrying. Anything else is treated as
 *  transient and the field keeps the -1 sentinel for retry. */
function isUnsupportedGetterError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason);
  return msg.includes("returned no data");
}

async function readFeeGetter(
  client: ReturnType<typeof getRpcClient>,
  poolAddress: string,
  functionName: "lpFee" | "protocolFee" | "rebalanceIncentive",
  mock: FeeGetterMock | undefined,
): Promise<bigint> {
  if (mock) {
    if ("fulfilled" in mock) return mock.fulfilled;
    if (mock.rejected === "unsupported") {
      throw new Error(
        `The contract function "${functionName}" returned no data ("0x").`,
      );
    }
    throw new Error("Mock transient RPC failure");
  }
  return client.readContract({
    address: poolAddress as `0x${string}`,
    abi: FPMM_FEE_ABI,
    functionName,
  }) as Promise<bigint>;
}

/** Test-only sentinel: `null` represents an RPC failure mock, distinct
 * from "no mock set" (which falls through to real RPC). */
const _testIncentiveAtBlock = new Map<string, number | null>();

/** @internal Test-only: pre-set a mock for `fetchRebalanceIncentiveAtBlock`.
 *  Pass a number (incl. -2) to return that bps; pass `null` to simulate
 *  RPC failure. Call `_clearMockRebalanceIncentivesAtBlock()` to reset. */
export function _setMockRebalanceIncentiveAtBlock(
  chainId: number,
  poolAddress: string,
  bps: number | null,
): void {
  _testIncentiveAtBlock.set(`${chainId}:${poolAddress.toLowerCase()}`, bps);
}

/** @internal Test-only: clear all `fetchRebalanceIncentiveAtBlock` mocks. */
export function _clearMockRebalanceIncentivesAtBlock(): void {
  _testIncentiveAtBlock.clear();
}

/** Read `rebalanceIncentive()` (bps) at a specific block. Used by the
 * Rebalanced handler to stamp the incentive that was actually in force
 * at the rebalance block, instead of inheriting `Pool.rebalanceReward`
 * (which can carry today's value during full resync — `fetchFees` self-
 * heals from `latest`, not block-scoped). On RPC failure or fallback
 * to `latest`, returns null and the caller falls back to the persisted
 * Pool value. The `-2` return value mirrors the `fetchFees` "getter
 * missing on this contract" sentinel — `Pool.rebalanceReward` uses it
 * to halt the upsertPool self-heal retry loop on older FPMM pools, and
 * propagating it here lets the Rebalanced handler short-circuit on
 * subsequent events for the same pool. */
export async function fetchRebalanceIncentiveAtBlock(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
): Promise<number | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testIncentiveAtBlock.has(testKey)) {
    return _testIncentiveAtBlock.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_FEE_ABI,
        functionName: "rebalanceIncentive",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    // Only `latest`-block fallback breaks block-scoping; secondary-RPC
    // fallback still queries the requested block, so its result is fine.
    if (usedLatestFallback) return null;
    return Number(result as bigint);
  } catch (err) {
    if (isUnsupportedGetterError(err)) return -2;
    logRpcFailure(chainId, "rebalanceIncentive", poolAddress, err, blockNumber);
    return null;
  }
}

/** Fetch FPMM fee config (bps): lpFee, protocolFee, rebalanceIncentive.
 * Returns only the fields whose RPC call succeeded so partial failure
 * doesn't overwrite already-populated fields; returns null when every
 * call fails so self-heal retries on the next touch. Fields that reject
 * with the "returned no data" signature get -2 (attempted, unsupported)
 * so self-heal stops retrying permanently-missing getters. */
export async function fetchFees(
  chainId: number,
  poolAddress: string,
): Promise<Partial<{
  lpFee: number;
  protocolFee: number;
  rebalanceReward: number;
}> | null> {
  // Outer try/catch covers getRpcClient, which throws on unknown chainIds
  // or missing HyperRPC tokens — those must degrade to null, not escape
  // into the handler and stall indexing for the rest of the event.
  try {
    const mockKey = `${chainId}:${poolAddress.toLowerCase()}`;
    const mock = _testFees.get(mockKey);
    if (mock?.rpcClientThrows) {
      throw new Error("Mock getRpcClient throw");
    }
    const client = getRpcClient(chainId);
    const results = await Promise.allSettled([
      readFeeGetter(client, poolAddress, "lpFee", mock?.lpFee),
      readFeeGetter(client, poolAddress, "protocolFee", mock?.protocolFee),
      readFeeGetter(
        client,
        poolAddress,
        "rebalanceIncentive",
        mock?.rebalanceReward,
      ),
    ]);
    const [lpFeeR, protocolFeeR, rebalanceRewardR] = results;
    if (
      lpFeeR.status === "rejected" &&
      protocolFeeR.status === "rejected" &&
      rebalanceRewardR.status === "rejected"
    ) {
      logRpcFailure(chainId, "fetchFees", poolAddress, lpFeeR.reason);
      return null;
    }
    const fees: Partial<{
      lpFee: number;
      protocolFee: number;
      rebalanceReward: number;
    }> = {};
    if (lpFeeR.status === "fulfilled") {
      fees.lpFee = Number(lpFeeR.value as bigint);
    } else if (isUnsupportedGetterError(lpFeeR.reason)) {
      fees.lpFee = -2;
    }
    if (protocolFeeR.status === "fulfilled") {
      fees.protocolFee = Number(protocolFeeR.value as bigint);
    } else if (isUnsupportedGetterError(protocolFeeR.reason)) {
      fees.protocolFee = -2;
    }
    if (rebalanceRewardR.status === "fulfilled") {
      fees.rebalanceReward = Number(rebalanceRewardR.value as bigint);
    } else if (isUnsupportedGetterError(rebalanceRewardR.reason)) {
      fees.rebalanceReward = -2;
    }
    return fees;
  } catch (err) {
    logRpcFailure(chainId, "fetchFees", poolAddress, err);
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

// Breaker RPC self-heal + bootstrap. See breakers.ts header for the why.

export type BreakerKindRpc = "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";

const _testBreakerList = new Map<number, string[] | null>();

/** @internal Test-only: pre-set the BreakerBox.getBreakers() result. */
export function _setMockBreakerList(
  chainId: number,
  breakers: string[] | null,
): void {
  _testBreakerList.set(chainId, breakers);
}

/** Returns all breaker addresses registered with BreakerBox at `blockNumber`,
 * or null if RPC fails / BreakerBox is not deployed on this chain. Used by
 * the eager bootstrap path: when a feed has no BreakerConfig rows but is
 * receiving MedianUpdated events, enumerate breakers and seed configs. */
export async function fetchBreakerList(
  chainId: number,
  blockNumber: bigint,
): Promise<string[] | null> {
  if (_testBreakerList.has(chainId)) return _testBreakerList.get(chainId)!;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
      client,
      {
        address: breakerBoxAddress,
        abi: [
          {
            type: "function",
            name: "getBreakers",
            inputs: [],
            outputs: [{ name: "", type: "address[]" }],
            stateMutability: "view",
          },
        ],
        functionName: "getBreakers",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    return (result as readonly string[]).map((a) => a.toLowerCase());
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerList",
      breakerBoxAddress,
      err,
      blockNumber,
    );
    return null;
  }
}

export type BreakerDefaults = {
  activatesTradingMode: number;
  defaultCooldownTime: bigint;
  defaultRateChangeThreshold: bigint;
};

export type BreakerFeedState = {
  enabled: boolean;
  tradingMode: number;
  lastStatusUpdatedAt: bigint;
  cooldownTime: bigint;
  rateChangeThreshold: bigint;
  // MD-only — null on VD / MARKET_HOURS.
  smoothingFactor: bigint | null;
  medianRatesEMA: bigint | null;
  // VD-only — null on MD / MARKET_HOURS.
  referenceValue: bigint | null;
};

// ---- Test mock hooks ----

const _testBreakerKinds = new Map<string, BreakerKindRpc | null>();
const _testBreakerDefaults = new Map<string, BreakerDefaults | null>();
const _testBreakerFeedState = new Map<string, BreakerFeedState | null>();

function breakerKindKey(chainId: number, breakerAddress: string): string {
  return `${chainId}:${breakerAddress.toLowerCase()}`;
}
function breakerFeedStateKey(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
): string {
  return `${chainId}:${breakerAddress.toLowerCase()}:${rateFeedID.toLowerCase()}`;
}

/** @internal Test-only: pre-set a BreakerKind probe result. */
export function _setMockBreakerKind(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc | null,
): void {
  _testBreakerKinds.set(breakerKindKey(chainId, breakerAddress), kind);
}

/** @internal Test-only: pre-set Breaker defaults (activatesTradingMode / cooldown / threshold). */
export function _setMockBreakerDefaults(
  chainId: number,
  breakerAddress: string,
  defaults: BreakerDefaults | null,
): void {
  _testBreakerDefaults.set(breakerKindKey(chainId, breakerAddress), defaults);
}

/** @internal Test-only: pre-set BreakerConfig per-feed RPC state. */
export function _setMockBreakerFeedState(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
  state: BreakerFeedState | null,
): void {
  _testBreakerFeedState.set(
    breakerFeedStateKey(chainId, breakerAddress, rateFeedID),
    state,
  );
}

/** @internal Test-only: clear all breaker mocks. */
export function _clearBreakerMocks(): void {
  _testBreakerKinds.clear();
  _testBreakerDefaults.clear();
  _testBreakerFeedState.clear();
  _testBreakerList.clear();
}

// ---- Probes & fetchers ----

/** Probe whether a breaker contract responds to a function. Returns true if
 * the call succeeds (even with zero result), false on revert. */
async function probeFunction(
  chainId: number,
  address: string,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<"present" | "missing" | "rpc_error"> {
  try {
    const client = getRpcClient(chainId);
    await client.readContract({
      address: address as `0x${string}`,
      abi: abi as never,
      functionName,
      args: args as never,
    });
    return "present";
  } catch (err) {
    // Distinguish "function not in bytecode" (selector miss) from a
    // transient RPC failure. viem's `ContractFunctionZeroDataError` is the
    // unambiguous signal — its `shortMessage` always contains the exact
    // phrase `returned no data ("0x")`. Matching just `"0x"` (which appears
    // in addresses, calldata, and many provider error payloads) or
    // `"execution reverted"` (which fires when the function EXISTS but
    // throws — e.g. a require() failure on the probe address) would
    // misclassify legitimate RPC/contract errors as selector misses and
    // permanently persist the wrong BreakerKind.
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return msg.includes("returned no data") ? "missing" : "rpc_error";
  }
}

/** Classify a breaker by selector probe. Order matters: MarketHours has
 * neither `medianRatesEMA` nor `referenceValues`, so we check MD-specific
 * first, then VD-specific, then default to MARKET_HOURS. The probe address
 * (`0x000…0001`) is a valid input that won't have any state — we only care
 * whether the function exists in the bytecode. Returns null on transient
 * RPC failure so the caller can retry rather than poisoning the kind. */
export async function fetchBreakerKind(
  chainId: number,
  breakerAddress: string,
): Promise<BreakerKindRpc | null> {
  const mock = _testBreakerKinds.get(breakerKindKey(chainId, breakerAddress));
  if (mock !== undefined) return mock ?? "MARKET_HOURS";

  const probeAddr = "0x0000000000000000000000000000000000000001";
  const mdProbe = await probeFunction(
    chainId,
    breakerAddress,
    MEDIAN_DELTA_BREAKER_ABI,
    "medianRatesEMA",
    [probeAddr],
  );
  if (mdProbe === "rpc_error") return null;
  if (mdProbe === "present") return "MEDIAN_DELTA";

  const vdProbe = await probeFunction(
    chainId,
    breakerAddress,
    VALUE_DELTA_BREAKER_ABI,
    "referenceValues",
    [probeAddr],
  );
  if (vdProbe === "rpc_error") return null;
  if (vdProbe === "present") return "VALUE_DELTA";

  // Both selectors confirmed missing — this is a MarketHours-style breaker.
  return "MARKET_HOURS";
}

/** Fetch breaker defaults from RPC. `activatesTradingMode` comes from
 * `BreakerBox.breakerTradingMode(breaker)`; `defaultCooldownTime` /
 * `defaultRateChangeThreshold` come from the breaker contract itself
 * (revert-safe — MarketHours has neither and falls back to 0). */
export async function fetchBreakerDefaults(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc,
  blockNumber: bigint,
): Promise<BreakerDefaults | null> {
  const cached = _testBreakerDefaults.get(
    breakerKindKey(chainId, breakerAddress),
  );
  if (cached !== undefined) return cached;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const tradingModeP = readContractWithBlockFallback(
      client,
      {
        address: breakerBoxAddress,
        abi: BREAKER_BOX_ABI,
        functionName: "breakerTradingMode",
        args: [breakerAddress as `0x${string}`],
      },
      blockNumber,
      fallback,
    );

    if (kind === "MARKET_HOURS") {
      const tm = await tradingModeP;
      return {
        activatesTradingMode: Number(tm.result as number),
        defaultCooldownTime: 0n,
        defaultRateChangeThreshold: 0n,
      };
    }

    const breakerAbi =
      kind === "MEDIAN_DELTA"
        ? MEDIAN_DELTA_BREAKER_ABI
        : VALUE_DELTA_BREAKER_ABI;
    const [tmRes, cdRes, thrRes] = await Promise.all([
      tradingModeP,
      readContractWithBlockFallback(
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "defaultCooldownTime",
        },
        blockNumber,
        fallback,
      ),
      readContractWithBlockFallback(
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "defaultRateChangeThreshold",
        },
        blockNumber,
        fallback,
      ),
    ]);
    return {
      activatesTradingMode: Number(tmRes.result as number),
      defaultCooldownTime: cdRes.result as bigint,
      defaultRateChangeThreshold: thrRes.result as bigint,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerDefaults",
      breakerAddress,
      err,
      blockNumber,
    );
    return null;
  }
}

/** Fetch full per-feed breaker state from RPC. Bundles
 * `BreakerBox.rateFeedBreakerStatus` + per-feed config + (kind-specific)
 * `medianRatesEMA` / `smoothingFactors` / `referenceValues`. Returns null if
 * any required call fails — caller decides whether to fall back to defaults
 * (sentinel 0) or skip. */
export async function fetchBreakerFeedState(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<BreakerFeedState | null> {
  const mock = _testBreakerFeedState.get(
    breakerFeedStateKey(chainId, breakerAddress, rateFeedID),
  );
  if (mock !== undefined) return mock;

  let breakerBoxAddress: `0x${string}`;
  try {
    breakerBoxAddress = requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }

  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const statusP = readContractWithBlockFallback(
      client,
      {
        address: breakerBoxAddress,
        abi: BREAKER_BOX_ABI,
        functionName: "rateFeedBreakerStatus",
        args: [rateFeedID as `0x${string}`, breakerAddress as `0x${string}`],
      },
      blockNumber,
      fallback,
    );

    if (kind === "MARKET_HOURS") {
      const s = await statusP;
      const status = parseRateFeedBreakerStatus(s.result);
      return {
        enabled: status.enabled,
        tradingMode: status.tradingMode,
        lastStatusUpdatedAt: status.lastUpdatedTime,
        cooldownTime: 0n,
        rateChangeThreshold: 0n,
        smoothingFactor: null,
        medianRatesEMA: null,
        referenceValue: null,
      };
    }

    const breakerAbi =
      kind === "MEDIAN_DELTA"
        ? MEDIAN_DELTA_BREAKER_ABI
        : VALUE_DELTA_BREAKER_ABI;

    const [statusRes, cdRes, thrRes, kindSpecific] = await Promise.all([
      statusP,
      readContractWithBlockFallback(
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "rateFeedCooldownTime",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        fallback,
      ),
      readContractWithBlockFallback(
        client,
        {
          address: breakerAddress as `0x${string}`,
          abi: breakerAbi,
          functionName: "rateChangeThreshold",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        fallback,
      ),
      kind === "MEDIAN_DELTA"
        ? Promise.all([
            readContractWithBlockFallback(
              client,
              {
                address: breakerAddress as `0x${string}`,
                abi: MEDIAN_DELTA_BREAKER_ABI,
                functionName: "smoothingFactors",
                args: [rateFeedID as `0x${string}`],
              },
              blockNumber,
              fallback,
            ),
            readContractWithBlockFallback(
              client,
              {
                address: breakerAddress as `0x${string}`,
                abi: MEDIAN_DELTA_BREAKER_ABI,
                functionName: "medianRatesEMA",
                args: [rateFeedID as `0x${string}`],
              },
              blockNumber,
              fallback,
            ),
          ])
        : readContractWithBlockFallback(
            client,
            {
              address: breakerAddress as `0x${string}`,
              abi: VALUE_DELTA_BREAKER_ABI,
              functionName: "referenceValues",
              args: [rateFeedID as `0x${string}`],
            },
            blockNumber,
            fallback,
          ),
    ]);

    const status = parseRateFeedBreakerStatus(statusRes.result);
    if (kind === "MEDIAN_DELTA") {
      const [sfRes, emaRes] = kindSpecific as [
        BlockFallbackResult,
        BlockFallbackResult,
      ];
      return {
        enabled: status.enabled,
        tradingMode: status.tradingMode,
        lastStatusUpdatedAt: status.lastUpdatedTime,
        cooldownTime: cdRes.result as bigint,
        rateChangeThreshold: thrRes.result as bigint,
        smoothingFactor: sfRes.result as bigint,
        medianRatesEMA: emaRes.result as bigint,
        referenceValue: null,
      };
    }
    const refRes = kindSpecific as BlockFallbackResult;
    return {
      enabled: status.enabled,
      tradingMode: status.tradingMode,
      lastStatusUpdatedAt: status.lastUpdatedTime,
      cooldownTime: cdRes.result as bigint,
      rateChangeThreshold: thrRes.result as bigint,
      smoothingFactor: null,
      medianRatesEMA: null,
      referenceValue: refRes.result as bigint,
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "fetchBreakerFeedState",
      `${breakerAddress}:${rateFeedID}`,
      err,
      blockNumber,
    );
    return null;
  }
}

/** viem decodes named struct outputs as objects, anonymous outputs as tuples.
 * `rateFeedBreakerStatus` has named outputs so this should always be the
 * object form, but we support tuple form defensively. */
function parseRateFeedBreakerStatus(raw: unknown): {
  tradingMode: number;
  lastUpdatedTime: bigint;
  enabled: boolean;
} {
  if (Array.isArray(raw)) {
    return {
      tradingMode: Number(raw[0]),
      lastUpdatedTime: BigInt(raw[1] as bigint | number),
      enabled: Boolean(raw[2]),
    };
  }
  const obj = raw as {
    tradingMode: number | bigint;
    lastUpdatedTime: number | bigint;
    enabled: boolean;
  };
  return {
    tradingMode: Number(obj.tradingMode),
    lastUpdatedTime: BigInt(obj.lastUpdatedTime),
    enabled: Boolean(obj.enabled),
  };
}

// ---- DB query helper ----

/** Returns all BreakerConfig rows on the given chain for the given rateFeedID.
 * Same in-memory chainId filter rationale as getPoolsByFeed — Envio's
 * single-field getWhere doesn't support compound queries. Result set is
 * always small (≤ 1 trip-able config per feed in production today). */
export async function getBreakerConfigsByFeed(
  context: HandlerContext,
  chainId: number,
  rateFeedID: string,
): Promise<BreakerConfig[]> {
  const rows = await context.BreakerConfig.getWhere.rateFeedID.eq(rateFeedID);
  return rows.filter((r) => r.chainId === chainId);
}
