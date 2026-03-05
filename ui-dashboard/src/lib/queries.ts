export const ALL_POOLS = `
  query AllPools {
    Pool(order_by: { createdAtBlock: desc }) {
      id
      token0
      token1
      source
      createdAtBlock
      createdAtTimestamp
      updatedAtBlock
      updatedAtTimestamp
    }
  }
`;

/** Extended pool query with oracle health fields — requires updated indexer schema */
export const ALL_POOLS_WITH_HEALTH = `
  query AllPoolsWithHealth {
    Pool(order_by: { createdAtBlock: desc }) {
      id
      token0
      token1
      source
      createdAtBlock
      createdAtTimestamp
      updatedAtBlock
      updatedAtTimestamp
      healthStatus
      oracleOk
      oraclePrice
      oraclePriceDenom
      oracleTimestamp
      priceDifference
      rebalanceThreshold
      oracleNumReporters
      lastRebalancedAt
      referenceRateFeedID
    }
  }
`;

export const RECENT_SWAPS = `
  query RecentSwaps($limit: Int!) {
    SwapEvent(order_by: { blockNumber: desc }, limit: $limit) {
      id poolId sender recipient
      amount0In amount1In amount0Out amount1Out
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_SWAPS = `
  query PoolSwaps($poolId: String!, $limit: Int!) {
    SwapEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockNumber: desc }
      limit: $limit
    ) {
      id poolId sender recipient
      amount0In amount1In amount0Out amount1Out
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_RESERVES = `
  query PoolReserves($poolId: String!, $limit: Int!) {
    ReserveUpdate(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockNumber: asc }
      limit: $limit
    ) {
      id reserve0 reserve1
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_REBALANCES = `
  query PoolRebalances($poolId: String!, $limit: Int!) {
    RebalanceEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockNumber: desc }
      limit: $limit
    ) {
      id sender priceDifferenceBefore priceDifferenceAfter
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_LIQUIDITY = `
  query PoolLiquidity($poolId: String!, $limit: Int!) {
    LiquidityEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockNumber: desc }
      limit: $limit
    ) {
      id kind sender recipient
      amount0 amount1 liquidity
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_DETAIL = `
  query PoolDetail($id: String!) {
    Pool(where: { id: { _eq: $id } }) {
      id token0 token1 source
      createdAtBlock createdAtTimestamp
      updatedAtBlock updatedAtTimestamp
    }
  }
`;

/** Extended pool detail with oracle health fields — requires updated indexer schema */
export const POOL_DETAIL_WITH_HEALTH = `
  query PoolDetailWithHealth($id: String!) {
    Pool(where: { id: { _eq: $id } }) {
      id token0 token1 source
      createdAtBlock createdAtTimestamp
      updatedAtBlock updatedAtTimestamp
      healthStatus
      oracleOk
      oraclePrice
      oraclePriceDenom
      oracleTimestamp
      oracleExpiry
      oracleNumReporters
      referenceRateFeedID
      priceDifference
      rebalanceThreshold
      lastRebalancedAt
    }
  }
`;

export const ORACLE_SNAPSHOTS = `
  query OracleSnapshots($poolId: String!, $limit: Int!) {
    OracleSnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: { timestamp: asc }
      limit: $limit
    ) {
      id
      poolId
      timestamp
      oraclePrice
      oraclePriceDenom
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
    }
  }
`;
