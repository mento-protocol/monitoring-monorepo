export const SUSDS_YIELD_DAILY_SNAPSHOTS = `
  query SusdsYieldDailySnapshots($chainId: Int!, $limit: Int!, $offset: Int!) {
    SusdsYieldDailySnapshot(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      chainId
      token
      timestamp
      currentShares
      costBasisUsdWei
      realizedYieldUsdWei
      transferredOutYieldUsdWei
      redeemedYieldUsdWei
      currentValueUsdWei
      unrealizedYieldUsdWei
      totalEarnedYieldUsdWei
      dailyEarnedYieldUsdWei
      dailyRealizedYieldUsdWei
      dailyUnrealizedYieldUsdWei
      sharePriceUsdWei
      sampledAtBlock
      sampledAtTimestamp
    }
  }
`;

// Consumed by lib/reserve-yield-susds.ts. Defined here so the GraphQL contract
// test covers it (the contract test imports this queries module directly).
export const SUSDS_YIELD_SUMMARY_QUERY = /* GraphQL */ `
  query SusdsYieldSummary($id: String!) {
    SusdsYieldSummary(where: { id: { _eq: $id } }, limit: 1) {
      id
      currentShares
      costBasisUsdWei
      realizedYieldUsdWei
      transferredOutYieldUsdWei
      redeemedYieldUsdWei
      currentValueUsdWei
      unrealizedYieldUsdWei
      totalEarnedYieldUsdWei
      sharePriceUsdWei
      lastUpdatedBlock
      lastUpdatedTimestamp
    }
  }
`;
