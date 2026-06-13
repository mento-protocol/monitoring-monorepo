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
