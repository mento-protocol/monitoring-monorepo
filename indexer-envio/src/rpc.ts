// ---------------------------------------------------------------------------
// Barrel re-exports + Oracle DB query helpers.
// Pool-state fetchers/caches/mocks live in `./rpc/pool-state`. Client
// management + structured failure logging live in `./rpc/client`. The
// `readContractWithBlockFallback` retry/fallback primitive lives in
// `./rpc/block-fallback`. Breaker RPC self-heal lives in `./rpc/breakers`.
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, Pool, BreakerConfig } from "envio";

// Re-export the client/log/rate-limit primitives so existing callers
// (feeToken.ts, EventHandlers.ts, breakers.ts, hyperRpcToken.test.ts, etc.)
// that import from "./rpc.js" continue to work after the split.
export {
  getRpcClient,
  getFallbackRpcClient,
  withHyperRpcToken,
  _clearRpcClients,
  _setRpcClientForTests,
} from "./rpc/client.js";
export {
  readContractWithBlockFallback,
  _testHooks,
} from "./rpc/block-fallback.js";
export type { BlockFallbackResult } from "./rpc/block-fallback.js";

// Re-export pool-state symbols so existing callers that import from "./rpc.js"
// continue to work without import-path changes (feeToken.ts, EventHandlers.ts,
// breakers.ts, pool.ts, and all test files).
export {
  _setMockRebalancingState,
  _clearMockRebalancingStates,
  _setMockReserves,
  _clearMockReserves,
  _setMockRebalanceThresholds,
  _clearMockRebalanceThresholds,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
  _setMockTokenDecimalsScaling,
  _clearMockTokenDecimalsScaling,
  fetchRebalancingState,
  fetchReserves,
  fetchInvertRateFeed,
  fetchRebalanceThresholds,
  fetchTokenDecimalsScaling,
  fetchErc20Decimals,
  fetchTradingLimits,
} from "./rpc/pool-state.js";
export {
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
  _setMockRateFeedOracles,
  _clearMockRateFeedOracles,
  fetchReferenceRateFeedID,
  fetchNumReporters,
  fetchRateFeedOracles,
  fetchReportExpiry,
} from "./rpc/oracle-state.js";
export {
  _setMockFees,
  _clearMockFees,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
  fetchRebalanceIncentiveAtBlock,
  fetchFees,
} from "./rpc/pool-fees.js";
export {
  _setMockPoolExchange,
  _clearMockPoolExchanges,
  _setMockVpExchangeId,
  _clearMockVpExchangeIds,
  fetchPoolExchange,
  fetchVirtualPoolExchangeId,
  extractVpExchangeIdFromBytecode,
} from "./rpc/biPoolManager.js";
export type { RebalancingState } from "./rpc/pool-state.js";
export type { FeeGetterMock, FetchFeesMock } from "./rpc/pool-fees.js";
export type {
  PoolExchangeStruct,
  VirtualPoolExchangeId,
} from "./rpc/biPoolManager.js";

// Re-export breaker RPC self-heal symbols so existing callers that import from
// "./rpc" (breakers.ts handler and all breaker test files) keep working.
export type {
  BreakerKindRpc,
  BreakerDefaults,
  BreakerFeedState,
} from "./rpc/breakers.js";
export {
  _setMockBreakerList,
  fetchBreakerList,
  _setMockBreakerKind,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
  _clearBreakerMocks,
  fetchBreakerKind,
  fetchBreakerDefaults,
  fetchBreakerFeedState,
} from "./rpc/breakers.js";

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
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<string[]> {
  const pools = await context.Pool.getWhere({
    referenceRateFeedID: { _eq: rateFeedID },
  });
  return pools.filter((p) => p.chainId === chainId).map((p) => p.id);
}

export async function updatePoolsOracleExpiry(
  context: EvmOnEventContext,
  poolIds: string[],
  // Accept null and undefined so callers can pass the `reportExpiryEffect`
  // result directly, plus historical paths that surface undefined, without
  // normalizing at every call site.
  oracleExpiry: bigint | null | undefined,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (oracleExpiry == null || poolIds.length === 0) return;

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
  context: EvmOnEventContext,
  chainId: number,
): Promise<Pool[]> {
  const pools = await context.Pool.getWhere({
    referenceRateFeedID: { _gt: "" },
  });
  return pools.filter((p) => p.chainId === chainId);
}

/** Returns all BreakerConfig rows on the given chain for the given rateFeedID.
 * Same in-memory chainId filter rationale as getPoolsByFeed — Envio's
 * single-field getWhere doesn't support compound queries. Result set is
 * always small (≤ 1 trip-able config per feed in production today). */
export async function getBreakerConfigsByFeed(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<BreakerConfig[]> {
  const rows = await context.BreakerConfig.getWhere({
    rateFeedID: { _eq: rateFeedID },
  });
  return rows.filter((r) => r.chainId === chainId);
}
