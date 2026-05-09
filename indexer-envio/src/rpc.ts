// ---------------------------------------------------------------------------
// Barrel re-exports + Oracle DB query helpers.
// Pool-state fetchers/caches/mocks live in `./rpc/pool-state`. Client
// management + structured failure logging live in `./rpc/client`. The
// `readContractWithBlockFallback` retry/fallback primitive lives in
// `./rpc/block-fallback`. Breaker RPC self-heal lives in `./rpc/breakers`.
// ---------------------------------------------------------------------------

import type { HandlerContext } from "generated/src/Types";
import type { Pool, BreakerConfig } from "generated";

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
  _setMockRebalanceThresholds,
  _clearMockRebalanceThresholds,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
  _setMockFees,
  _clearMockFees,
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
  _setMockPoolExchange,
  _clearMockPoolExchanges,
  _setMockVpExchangeId,
  _clearMockVpExchangeIds,
  fetchRebalancingState,
  fetchReserves,
  fetchInvertRateFeed,
  fetchRebalanceThresholds,
  fetchReferenceRateFeedID,
  fetchNumReporters,
  fetchReportExpiry,
  fetchTokenDecimalsScaling,
  fetchErc20Decimals,
  fetchTradingLimits,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
  fetchRebalanceIncentiveAtBlock,
  fetchFees,
  fetchPoolExchange,
  fetchVirtualPoolExchangeId,
  extractVpExchangeIdFromBytecode,
} from "./rpc/pool-state";
export type {
  RebalancingState,
  FeeGetterMock,
  FetchFeesMock,
  PoolExchangeStruct,
  VirtualPoolExchangeId,
} from "./rpc/pool-state";

// Re-export breaker RPC self-heal symbols so existing callers that import from
// "./rpc" (breakers.ts handler and all breaker test files) keep working.
export type {
  BreakerKindRpc,
  BreakerDefaults,
  BreakerFeedState,
} from "./rpc/breakers";
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
} from "./rpc/breakers";

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
  // Accept undefined too so callers can pass the `reportExpiryEffect` result
  // (Sury maps null → undefined) without normalizing at every call site.
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
  context: HandlerContext,
  chainId: number,
): Promise<Pool[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.gt("");
  return pools.filter((p) => p.chainId === chainId);
}

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
