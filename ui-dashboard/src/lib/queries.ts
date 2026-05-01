// Pool list + per-pool event/snapshot/breach queries are extracted to ./queries/pools
// so this barrel can grow without breaking the per-domain organisation downstream.
// Re-exported here to keep existing `from "@/lib/queries"` imports stable.
export * from "./queries/pools";
export * from "./queries/config";

// Preferred LP ownership query. Environments without LiquidityPosition should
// show a migration message rather than attempt a correctness-risky fallback.
export const POOL_LP_POSITIONS = `
  query PoolLpPositions($poolId: String!) {
    LiquidityPosition(
      where: { poolId: { _eq: $poolId } }
      order_by: { netLiquidity: desc }
    ) {
      id address netLiquidity lastUpdatedBlock lastUpdatedTimestamp
    }
  }
`;

export const UNIQUE_LP_ADDRESSES = `
  query UniqueLpAddresses($poolIds: [String!]!) {
    LiquidityPosition(
      where: { poolId: { _in: $poolIds }, netLiquidity: { _gt: "0" } }
      limit: 10000
    ) {
      address
    }
  }
`;

export const OLS_POOL = `
  query OlsPool($poolId: String!) {
    OlsPool(
      where: { poolId: { _eq: $poolId }, isActive: { _eq: true } }
      order_by: { updatedAtTimestamp: desc }
      limit: 1
    ) {
      id chainId poolId olsAddress isActive debtToken
      rebalanceCooldown lastRebalance
      protocolFeeRecipient
      liquiditySourceIncentiveExpansion
      liquiditySourceIncentiveContraction
      protocolIncentiveExpansion
      protocolIncentiveContraction
      olsRebalanceCount
      addedAtBlock addedAtTimestamp
      updatedAtBlock updatedAtTimestamp
    }
  }
`;

export const OLS_LIQUIDITY_EVENTS_PAGE = `
  query OlsLiquidityEventsPage($poolId: String!, $olsAddress: String!, $limit: Int!, $offset: Int!, $orderBy: [OlsLiquidityEvent_order_by!]!) {
    OlsLiquidityEvent(
      where: { poolId: { _eq: $poolId }, olsAddress: { _eq: $olsAddress } }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId direction caller
      tokenGivenToPool amountGivenToPool
      tokenTakenFromPool amountTakenFromPool
      txHash blockNumber blockTimestamp
    }
  }
`;

export const OLS_LIQUIDITY_EVENTS_COUNT = `
  query OlsLiquidityEventsCount($poolId: String!, $olsAddress: String!, $limit: Int!, $offset: Int!) {
    OlsLiquidityEvent(
      where: { poolId: { _eq: $poolId }, olsAddress: { _eq: $olsAddress } }
      limit: $limit
      offset: $offset
    ) {
      id
    }
  }
`;

export const ALL_OLS_POOLS = `
  query AllOlsPools($chainId: Int!) {
    OlsPool(
      where: { isActive: { _eq: true }, chainId: { _eq: $chainId } }
      limit: 1000
    ) {
      poolId
    }
  }
`;

/**
 * Fetch all protocol fee transfers for client-side USD aggregation.
 *
 * Capped at 10 000 rows as a safety net. Fee transfers are infrequent (the
 * yield split address receives fees only on swap activity, typically
 * hundreds/year), so this limit won't clip real data for a long time.
 *
 * Future: move USD conversion into a Hasura computed field or materialised
 * view so the browser only receives two numbers instead of N rows.
 */
export const PROTOCOL_FEE_TRANSFERS_ALL = `
  query ProtocolFeeTransfersAll($chainId: Int!) {
    ProtocolFeeTransfer(
      where: { chainId: { _eq: $chainId } }
      limit: 10000
      order_by: { blockTimestamp: desc }
    ) {
      chainId
      tokenSymbol
      tokenDecimals
      amount
      blockTimestamp
    }
  }
`;
