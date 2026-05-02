// OLS (Off-chain Liquidity Source) pool + liquidity-event queries. The barrel
// re-export lives in `../queries.ts` so existing `from "@/lib/queries"` imports
// stay stable; consumers can also import directly from this module.

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
