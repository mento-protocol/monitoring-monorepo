// ---------------------------------------------------------------------------
// Pool/oracle/breaker fetchers + caches + test mocks. Client management,
// structured failure logging, and rate-limit detection live in `./rpc/client`.
// ---------------------------------------------------------------------------

import type { HandlerContext } from "generated/src/Types";
import type { Pool, BreakerConfig } from "generated";
import {
  BREAKER_BOX_ABI,
  MEDIAN_DELTA_BREAKER_ABI,
  VALUE_DELTA_BREAKER_ABI,
} from "./abis";
import { requireContractAddress } from "./contractAddresses";
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

// Re-export pool-state symbols so existing callers that import from "./rpc"
// continue to work without import-path changes (feeToken.ts, EventHandlers.ts,
// breakers.ts, pool.ts, and all test files).
export {
  _setMockRebalancingState,
  _clearMockRebalancingStates,
  _setMockReserves,
  _clearMockReserves,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
  _setMockFees,
  _clearMockFees,
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
  _evictCacheForChain,
  _getOracleCacheStats,
  fetchRebalancingState,
  _resetRebalancingStateCacheForTests,
  fetchReserves,
  fetchInvertRateFeed,
  fetchRebalanceThreshold,
  fetchReferenceRateFeedID,
  fetchNumReporters,
  fetchReportExpiry,
  _resetReportExpiryInFlightForTests,
  fetchTokenDecimalsScaling,
  fetchTradingLimits,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
  fetchRebalanceIncentiveAtBlock,
  fetchFees,
} from "./rpc/pool-state";
export type {
  RebalancingState,
  FeeGetterMock,
  FetchFeesMock,
} from "./rpc/pool-state";

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
