// Pool/reserves/decimals/fees fetchers + caches + test mocks.
// Deps flow: pool-state → client, block-fallback, abis, contractAddresses, tradingLimits.

import {
  SortedOraclesContract,
  FPMM_MINIMAL_ABI,
  FPMM_FEE_ABI,
  FPMM_TRADING_LIMITS_ABI,
  ERC20_DECIMALS_ABI,
} from "../abis";
import type { TradingLimitData } from "../tradingLimits";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client";
import { readContractWithBlockFallback } from "./block-fallback";

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
// Two important invariants:
// 1. Only cache `usedFallback=false` results. If the request fell back
//    to `latest` (e.g. requested block not yet available), the response
//    isn't actually scoped to the cache key's blockNumber, so caching
//    it would serve stale-across-block data to later callers.
//    NOTE: this caching invariant differs slightly from `fetchReserves`,
//    which uses the stricter `usedLatestFallback` distinction to also
//    return null on `latest` fallback (rebalance-delta callers need
//    historical exactness). Event-dedup callers here only need the
//    current state, so eviction-on-any-fallback is sufficient.
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
  if (_testRateFeedIDs.has(mockKey))
    return _testRateFeedIDs.get(mockKey) ?? null;

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
  if (_testReportExpiry.has(mockKey))
    return _testReportExpiry.get(mockKey) ?? null;

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
