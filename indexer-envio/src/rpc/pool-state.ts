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

/**
 * Fetch a token's `decimals()` value as an integer (e.g., 18 for cUSD, 6 for
 * USDC). Production-safe: consults the test-only mock map first, then RPC.
 * Result is NOT cached at this layer — callers that fire on every event
 * (e.g., `Broker.Swap`) must add their own per-process cache.
 *
 * Returns `null` on RPC failure or implausible decimals (>36) — callers
 * should default to 18 in that case rather than block on the read.
 */
export async function fetchErc20Decimals(
  chainId: number,
  tokenAddress: string,
): Promise<number | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const mocked = _testERC20Decimals.get(key);
  if (mocked !== undefined) return mocked;
  try {
    const client = getRpcClient(chainId);
    const raw = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });
    const d = Number(raw);
    if (d < 0 || d > 36) return null;
    return d;
  } catch (err) {
    logRpcFailure(chainId, "erc20Decimals", tokenAddress, err);
    return null;
  }
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

/** Returns SortedOracles address for chainId, throws if not in @mento-protocol/contracts. */
const SORTED_ORACLES_ADDRESS = SortedOraclesContract.address;

// Per-block in-process caches (numReportersCache, reportExpiryCache,
// reservesCache, _rebalancingStateCache, _reportExpiryInFlight) used to live
// here. They were deduplication shims for handlers that fired the same RPC
// concurrently or across same-block events. Envio's Effect API runs
// equivalent dedup at the batch level — every caller now goes through
// `context.effect(...)` from src/rpc/effects.ts, so the shims are
// redundant. Removed in the createEffect migration; `git log` has the
// pre-migration design.

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

/** Fetch on-chain getRebalancingState() for a pool at a specific block.
 * Returns null on RPC failure so callers preserve stale state.
 *
 * Cross-event dedup (FPMM emits 2× UR + 1× Rebalanced in the same rebalance
 * tx) is handled upstream by `rebalancingStateEffect` in src/rpc/effects.ts
 * — Envio's Effect API memoizes per-batch on identical inputs. */
export async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
): Promise<RebalancingState | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "getRebalancingState",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    return parseRebalancingState(result);
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
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
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
    return { reserve0: r[0], reserve1: r[1] };
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
 * the given block, or null on error. Per-batch dedup is handled by
 * `numReportersEffect` in src/rpc/effects.ts. */
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
  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
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
    return Number(result);
  } catch (err) {
    logRpcFailure(chainId, "numRates", rateFeedID, err, blockNumber);
    return null;
  }
}

/** Returns the effective oracle report expiry (seconds) for the given
 * rateFeedID. Returns null on RPC/address error so callers can preserve the
 * previous known-good value. Concurrent-call dedup (oracle handlers fan out
 * across pools sharing a feed) is handled upstream by `reportExpiryEffect`
 * in src/rpc/effects.ts — Envio's Effect API memoizes per-batch on
 * identical inputs. */
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
  try {
    const client = getRpcClient(chainId);
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
      expiry = globalRes.result as bigint;
    }
    if (expiry <= 0n) return null;
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
    const decimals = await fetchErc20Decimals(chainId, fallbackTokenAddress);
    return decimals == null ? null : 10n ** BigInt(decimals);
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
