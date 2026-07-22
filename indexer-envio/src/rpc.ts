// ---------------------------------------------------------------------------
// Barrel re-exports + Oracle DB query helpers.
// Pool-state fetchers/caches/mocks live in `./rpc/pool-state`. Client
// management + structured failure logging live in `./rpc/client`. The
// `readContractWithBlockFallback` retry/fallback primitive lives in
// `./rpc/block-fallback`. Breaker RPC self-heal lives in `./rpc/breakers`.
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, Pool, BreakerConfig } from "envio";
import { updateHealthAccumulators } from "./healthScore.js";

// Re-export the client/log/rate-limit primitives so existing callers
// (feeToken.ts, EventHandlers.ts, breakers.ts, hyperRpcToken.test.ts, etc.)
// that import from "./rpc.js" continue to work after the split.
export {
  getRpcClient,
  getFallbackRpcClient,
  logRpcFailure,
  withHyperRpcToken,
  _clearRpcClients,
  _setRpcClientForTests,
} from "./rpc/client.js";
export {
  readContractWithBlockFallback,
  _testHooks,
} from "./rpc/block-fallback.js";
export type { BlockFallbackResult } from "./rpc/block-fallback.js";
export { fetchBlockTimestamp } from "./rpc/block.js";

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
  _setMockReportExpiryConfig,
  _clearMockReportExpiry,
  _setMockMedianTimestamp,
  _clearMockMedianTimestamps,
  _setMockOracleReportTimestamps,
  _clearMockOracleReportTimestamps,
  _setMockRateFeedOracles,
  _clearMockRateFeedOracles,
  _setMockNumReporters,
  _clearMockNumReporters,
  fetchReferenceRateFeedID,
  fetchNumReporters,
  fetchRateFeedOracles,
  fetchOracleReportTimestamps,
  fetchReportExpiry,
  fetchReportExpiryConfig,
  fetchMedianTimestamp,
} from "./rpc/oracle-state.js";
export type { ReportExpiryConfig } from "./rpc/oracle-state.js";
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
  fetchRateFeedDependencies,
} from "./rpc/breakers.js";
export {
  _setMockStableTotalSupply,
  _clearMockStableTotalSupply,
  _setMockStableBalanceOf,
  _clearMockStableBalanceOf,
  fetchStableTotalSupply,
  fetchStableBalanceOf,
} from "./rpc/stable-fetchers.js";

// ---------------------------------------------------------------------------
// Oracle DB query helpers (used by SortedOracles handlers)
// ---------------------------------------------------------------------------

/** Returns all FPMM pool IDs on the given chain that reference the given rateFeedID.
 * Uses context.Pool.getWhere (DB-backed) so it works correctly in Envio's
 * multi-process hosted environment. HyperIndex >=3.2 supports multi-field
 * getWhere, so keep the chain filter in the preloadable DB query instead of
 * fetching cross-chain rows and filtering in JS. */
export async function getPoolsByFeed(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<string[]> {
  const pools = await context.Pool.getWhere({
    chainId: { _eq: chainId },
    referenceRateFeedID: { _eq: rateFeedID },
  });
  return pools.map((p) => p.id);
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

    // The new expiry takes effect at this event boundary. Finalize the open
    // interval with the PRIOR expiry first; otherwise extending a feed from
    // minutes to one year would retroactively turn an already-stale gap into
    // healthy time. Do not create a health cursor when the pool has never had
    // a health sample.
    const healthBoundary =
      existing.lastOracleSnapshotTimestamp > 0n
        ? updateHealthAccumulators(
            existing,
            blockTimestamp,
            existing.lastDeviationRatio,
            {
              reportTimestamp: existing.lastOracleReportAt,
              expiry: existing.oracleExpiry,
            },
          )
        : {};

    const updatedPool: Pool = {
      ...existing,
      ...healthBoundary,
      // An expiry configuration event is not itself a trusted deviation
      // sample, so it must not promote an N/A pool into hasHealthData=true.
      hasHealthData: existing.hasHealthData,
      oracleExpiry,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.Pool.set(updatedPool);
  }
}

export async function updatePoolsOracleNumReporters(args: {
  context: EvmOnEventContext;
  poolIds: string[];
  oracleNumReporters: number | null | undefined;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<void> {
  if (args.oracleNumReporters == null || args.poolIds.length === 0) return;

  for (const poolId of args.poolIds) {
    const existing = await args.context.Pool.get(poolId);
    if (!existing || existing.oracleNumReporters === args.oracleNumReporters) {
      continue;
    }

    const updatedPool: Pool = {
      ...existing,
      oracleNumReporters: args.oracleNumReporters,
      updatedAtBlock: args.blockNumber,
      updatedAtTimestamp: args.blockTimestamp,
    };
    args.context.Pool.set(updatedPool);
  }
}

/** Returns all pools on a chain with a non-empty reference feed. */
export async function getPoolsWithReferenceFeed(
  context: EvmOnEventContext,
  chainId: number,
): Promise<Pool[]> {
  return context.Pool.getWhere({
    chainId: { _eq: chainId },
    referenceRateFeedID: { _gt: "" },
  });
}

/** Returns all BreakerConfig rows on the given chain for the given rateFeedID.
 * Uses HyperIndex >=3.2 multi-field getWhere so breaker fan-out stays bounded
 * at the storage layer. */
export async function getBreakerConfigsByFeed(
  context: EvmOnEventContext,
  chainId: number,
  rateFeedID: string,
): Promise<BreakerConfig[]> {
  return context.BreakerConfig.getWhere({
    chainId: { _eq: chainId },
    rateFeedID: { _eq: rateFeedID },
  });
}
