// Pool/reserves/decimals/oracle fetchers + caches + test mocks.
// Deps flow: pool-state → client, block-fallback, abis, contractAddresses, tradingLimits.

import {
  FPMM_MINIMAL_ABI,
  FPMM_TRADING_LIMITS_ABI,
  ERC20_DECIMALS_ABI,
} from "../abis.js";
import type { TradingLimitData } from "../tradingLimits.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { consoleLogger, type RpcLogger } from "./log.js";
import {
  clearPoolStateHttpMocks,
  registerMockERC20DecimalsHttp,
  registerMockRebalanceThresholdsHttp,
  registerMockRebalancingStateHttp,
  registerMockReservesHttp,
  registerMockTokenDecimalsScalingHttp,
} from "./http-test-mock-bridge.js";

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
  _testRebalancingStates.set(key, state);
  registerMockRebalancingStateHttp(chainId, poolAddress, state);
}

/** @internal Test-only: clear all mock rebalancing states. */
export function _clearMockRebalancingStates(): void {
  _testRebalancingStates.clear();
  clearPoolStateHttpMocks("rebalancingState");
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
  registerMockReservesHttp(chainId, poolAddress, reserves);
}

/** @internal Test-only: clear all mock reserves. */
export function _clearMockReserves(): void {
  _testReserves.clear();
  clearPoolStateHttpMocks("reserves");
}

/** @internal Test-only: pre-set mock ERC20 decimals for a token address. */
const _testERC20Decimals = new Map<string, number>();

export function _setMockERC20Decimals(
  chainId: number,
  tokenAddress: string,
  decimals: number,
): void {
  _testERC20Decimals.set(`${chainId}:${tokenAddress.toLowerCase()}`, decimals);
  registerMockERC20DecimalsHttp(chainId, tokenAddress, decimals);
}

export function _clearMockERC20Decimals(): void {
  _testERC20Decimals.clear();
  clearPoolStateHttpMocks("erc20Decimals");
}

/** @internal Test-only: pre-set mock decimals0()/decimals1() scaling.
 * Pass `null` to simulate a transient RPC failure. */
const _testTokenDecimalsScaling = new Map<string, bigint | null>();

export function _setMockTokenDecimalsScaling(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
  value: bigint | null,
): void {
  _testTokenDecimalsScaling.set(
    `${chainId}:${poolAddress.toLowerCase()}:${fn}`,
    value,
  );
  registerMockTokenDecimalsScalingHttp(chainId, poolAddress, fn, value);
}

export function _clearMockTokenDecimalsScaling(): void {
  _testTokenDecimalsScaling.clear();
  clearPoolStateHttpMocks("tokenDecimalsScaling");
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
  log: RpcLogger = consoleLogger,
): Promise<number | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const mocked = _testERC20Decimals.get(key);
  if (mocked !== undefined) return mocked;
  try {
    const client = getRpcClient(chainId);
    // Route through readContractWithBlockFallback (with no blockNumber)
    // for free rate-limit retry + secondary-RPC fallback. Without this,
    // a primary rate-limit on `decimals()` throws straight to the caller
    // and dumps a viem stack trace into the warn channel.
    const { result } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      },
      undefined,
      getFallbackRpcClient(chainId),
      log,
    );
    const d = Number(result);
    if (d < 0 || d > 36) return null;
    return d;
  } catch (err) {
    logRpcFailure(chainId, "erc20Decimals", tokenAddress, err, undefined, log);
    return null;
  }
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
 * Returns null on RPC failure or `latest`-block fallback so callers
 * preserve stale state instead of being silently fed wrong-block data.
 * Matches the pattern in `fetchReserves` / `fetchRebalanceIncentiveAtBlock`.
 *
 * Cross-event dedup (FPMM emits 2× UR + 1× Rebalanced in the same rebalance
 * tx) is handled upstream by `rebalancingStateEffect` in src/rpc/effects.ts
 * — Envio's Effect API memoizes per-batch on identical inputs. The
 * `usedLatestFallback` null gate matters here: without it, the effect
 * would memoize a `latest`-block result across the whole batch and serve
 * it to every later caller as if it were block-scoped to their block. */
export async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<RebalancingState | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "getRebalancingState",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return parseRebalancingState(result);
  } catch (err) {
    logRpcFailure(
      chainId,
      "getRebalancingState",
      poolAddress,
      err,
      blockNumber,
      log,
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
  log: RpcLogger = consoleLogger,
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testReserves.has(testKey)) {
    const mock = _testReserves.get(testKey);
    return mock === NULL_RESERVES ? null : (mock ?? null);
  }
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "getReserves",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
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
    logRpcFailure(chainId, "getReserves", poolAddress, err, blockNumber, log);
    return null;
  }
}

/** Fetch the pool's invertRateFeed flag. Returns null on RPC error so the
 * caller can distinguish "RPC failed" from a real `false`. Under v3's
 * always-on preload, an effect that returned a fabricated `false` on a
 * transient blip would memoize and persist the wrong orientation for an
 * actually-inverted pool — every downstream oracle/health calc would be on
 * the wrong side of the rate until reindex. Caller skips the assignment on
 * null and the schema default (false) survives until the next event triggers
 * a re-fetch. */
export async function fetchInvertRateFeed(
  chainId: number,
  poolAddress: string,
  log: RpcLogger = consoleLogger,
): Promise<boolean | null> {
  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "invertRateFeed",
      },
      undefined,
      getFallbackRpcClient(chainId),
      log,
    );
    return result as boolean;
  } catch (err) {
    logRpcFailure(chainId, "invertRateFeed", poolAddress, err, undefined, log);
    return null;
  }
}

/** @internal Test-only: pre-set mock thresholds for a pool address. The
 * factory and self-heal paths read this map first, falling through to the
 * live RPC only when no mock is set. Call `_clearMockRebalanceThresholds()`
 * between tests to avoid leaking state. */
const _testRebalanceThresholds = new Map<
  string,
  { above: number; below: number } | null
>();

export function _setMockRebalanceThresholds(
  chainId: number,
  poolAddress: string,
  thresholds: { above: number; below: number } | null,
): void {
  _testRebalanceThresholds.set(
    `${chainId}:${poolAddress.toLowerCase()}`,
    thresholds,
  );
  registerMockRebalanceThresholdsHttp(chainId, poolAddress, thresholds);
}

export function _clearMockRebalanceThresholds(): void {
  _testRebalanceThresholds.clear();
  clearPoolStateHttpMocks("rebalanceThresholds");
}

/** Fetch the pool's rebalance thresholds (above and below) at a specific
 * block. Standalone getters do NOT require the oracle to be live (unlike
 * getRebalancingState which reverts on stale/expired oracle data). Returns
 * `{above, below}` or `null` on transient RPC failure. Block-scoped because
 * thresholds are governance-mutable via `RebalanceThresholdUpdated`; reading
 * at chain head would corrupt historical replay (factory at block N would
 * persist post-update values for pools whose thresholds changed at N+M). */
export async function fetchRebalanceThresholds(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<{ above: number; below: number } | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalanceThresholds.has(testKey)) {
    return _testRebalanceThresholds.get(testKey) ?? null;
  }
  try {
    const client = getRpcClient(chainId);
    const fallback = getFallbackRpcClient(chainId);
    const [aboveRes, belowRes] = await Promise.all([
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_MINIMAL_ABI,
          functionName: "rebalanceThresholdAbove",
        },
        blockNumber,
        fallback,
        log,
      ),
      readContractWithBlockFallback(
        chainId,
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_MINIMAL_ABI,
          functionName: "rebalanceThresholdBelow",
        },
        blockNumber,
        fallback,
        log,
      ),
    ]);
    // `latest`-fallback would silently return chain-head thresholds, which
    // would re-introduce the historical-corruption bug this block-scoped
    // signature was added to prevent. Reject the read in that case so the
    // caller's null-handling path runs.
    if (aboveRes.usedLatestFallback || belowRes.usedLatestFallback) return null;
    return {
      above: Number(aboveRes.result),
      below: Number(belowRes.result),
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "rebalanceThreshold",
      poolAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/** Fetches decimals0() or decimals1() from an FPMM pool — returns the
 *  scaling factor (e.g. 1000000000000000000n for 18dp, 1000000n for 6dp).
 *  Returns null on RPC failure so the caller (the effect handler) can
 *  fall back to `erc20DecimalsEffect` and benefit from effect-level dedup
 *  on shared fallback tokens. */
export async function fetchTokenDecimalsScaling(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const mockKey = `${chainId}:${poolAddress.toLowerCase()}:${fn}`;
  if (_testTokenDecimalsScaling.has(mockKey)) {
    return _testTokenDecimalsScaling.get(mockKey) ?? null;
  }

  try {
    const client = getRpcClient(chainId);
    const { result } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: fn,
      },
      undefined,
      getFallbackRpcClient(chainId),
      log,
    );
    const scaling = result as bigint;
    // Bounds check — mirror the ERC20 fallback path's `d < 0 || d > 36`
    // guard. A malicious or buggy RPC returning an oversized BigInt would
    // otherwise be cached (`tokenDecimalsScalingEffect.cache = true`) and
    // poison every downstream volume/reserve calculation forever. The
    // permitted range is [1, 10^36] — ERC20 supports up to 36 decimals.
    // Returning null routes the caller to the ERC20 fallback path.
    // sec-review 2026-05-22 f-003 (codex-validated).
    if (scaling <= 0n || scaling > 10n ** 36n) {
      logRpcFailure(
        chainId,
        fn,
        poolAddress,
        new Error(`out-of-range scaling factor ${scaling.toString()}`),
        undefined,
        log,
      );
      return null;
    }
    return scaling;
  } catch (err) {
    logRpcFailure(chainId, fn, poolAddress, err, undefined, log);
    return null;
  }
}

export async function fetchTradingLimits(
  chainId: number,
  poolAddress: string,
  token: string,
  blockNumber?: bigint,
  log: RpcLogger = consoleLogger,
): Promise<TradingLimitData | null> {
  try {
    const client = getRpcClient(chainId);
    const { result: raw, usedLatestFallback } =
      await readContractWithBlockFallback(
        chainId,
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_TRADING_LIMITS_ABI,
          functionName: "getTradingLimits",
          args: [token as `0x${string}`],
        },
        blockNumber,
        getFallbackRpcClient(chainId),
        log,
      );
    // Trading limit `state` (netflow0/1, lastUpdated0/1) accumulates with
    // each swap, so a `latest`-block fallback is fundamentally non-
    // historical. The Swap handler reading limits "at this event's block"
    // would otherwise persist current-block netflow against a 6-hour-old
    // event during catch-up. Reject and let the caller skip the limit
    // update for this event.
    if (usedLatestFallback) return null;
    const result = raw as [
      { limit0: bigint; limit1: bigint; decimals: number },
      {
        lastUpdated0: number;
        lastUpdated1: number;
        netflow0: bigint;
        netflow1: bigint;
      },
    ];
    const [config, state] = result;
    return {
      config,
      state: {
        lastUpdated0: BigInt(state.lastUpdated0),
        lastUpdated1: BigInt(state.lastUpdated1),
        netflow0: state.netflow0,
        netflow1: state.netflow1,
      },
    };
  } catch (err) {
    logRpcFailure(
      chainId,
      "getTradingLimits",
      poolAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}
