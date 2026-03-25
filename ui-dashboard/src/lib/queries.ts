export const ALL_POOLS_WITH_HEALTH = `
  query AllPoolsWithHealth {
    Pool(order_by: { createdAtBlock: desc }) {
      id
      token0
      token1
      token0Decimals
      token1Decimals
      source
      createdAtBlock
      createdAtTimestamp
      updatedAtBlock
      updatedAtTimestamp
      healthStatus
      oracleOk
      oraclePrice
      oracleTimestamp
      oracleTxHash
      priceDifference
      rebalanceThreshold
      oracleNumReporters
      oracleExpiry
      lastRebalancedAt
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      rebalanceLivenessStatus
      referenceRateFeedID
      swapCount
      rebalanceCount
      notionalVolume0
      notionalVolume1
      reserves0
      reserves1
    }
  }
`;

export const POOL_SNAPSHOTS_24H = `
  query PoolSnapshots24h($from: numeric!, $to: numeric!, $poolIds: [String!]!) {
    PoolSnapshot(
      where: {
        timestamp: { _gte: $from, _lt: $to }
        poolId: { _in: $poolIds }
      }
    ) {
      poolId
      swapCount
      swapVolume0
      swapVolume1
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
      id sender caller priceDifferenceBefore priceDifferenceAfter
      txHash blockNumber blockTimestamp
      improvement effectivenessRatio
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

export const POOL_DETAIL_WITH_HEALTH = `
  query PoolDetailWithHealth($id: String!) {
    Pool(where: { id: { _eq: $id } }) {
      id token0 token1 token0Decimals token1Decimals source
      createdAtBlock createdAtTimestamp
      updatedAtBlock updatedAtTimestamp
      healthStatus
      oracleOk
      oraclePrice
      oracleTimestamp
      oracleTxHash
      oracleExpiry
      oracleNumReporters
      referenceRateFeedID
      priceDifference
      rebalanceThreshold
      lastRebalancedAt
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      rebalanceLivenessStatus
      reserves0
      reserves1
    }
  }
`;

export const POOL_SNAPSHOTS = `
  query PoolSnapshots($poolId: String!, $limit: Int!) {
    PoolSnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: { timestamp: asc }
      limit: $limit
    ) {
      id poolId timestamp
      reserves0 reserves1
      swapCount swapVolume0 swapVolume1
      rebalanceCount cumulativeSwapCount
      cumulativeVolume0 cumulativeVolume1
      blockNumber
    }
  }
`;

export const TRADING_LIMITS = `
  query TradingLimits($poolId: String!) {
    TradingLimit(where: { poolId: { _eq: $poolId } }) {
      id token limit0 limit1 decimals
      netflow0 netflow1
      lastUpdated0 lastUpdated1
      limitPressure0 limitPressure1
      limitStatus updatedAtBlock updatedAtTimestamp
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
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
    }
  }
`;

export const POOL_DEPLOYMENT = `
  query PoolDeployment($poolId: String!) {
    FactoryDeployment(
      where: { poolId: { _eq: $poolId } }
      limit: 1
    ) {
      txHash
    }
  }
`;

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

export const OLS_POOL = `
  query OlsPool($poolId: String!) {
    OlsPool(
      where: { poolId: { _eq: $poolId }, isActive: { _eq: true } }
      order_by: { updatedAtTimestamp: desc }
      limit: 1
    ) {
      id poolId olsAddress isActive debtToken
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

export const OLS_LIQUIDITY_EVENTS = `
  query OlsLiquidityEvents($poolId: String!, $olsAddress: String!, $limit: Int!) {
    OlsLiquidityEvent(
      where: { poolId: { _eq: $poolId }, olsAddress: { _eq: $olsAddress } }
      order_by: { blockTimestamp: desc }
      limit: $limit
    ) {
      id direction caller
      tokenGivenToPool amountGivenToPool
      tokenTakenFromPool amountTakenFromPool
      txHash blockNumber blockTimestamp
    }
  }
`;

export const ALL_OLS_POOLS = `
  query AllOlsPools {
    OlsPool(where: { isActive: { _eq: true } }) {
      id
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
  query ProtocolFeeTransfersAll {
    ProtocolFeeTransfer(limit: 10000, order_by: { blockTimestamp: desc }) {
      tokenSymbol
      tokenDecimals
      amount
      blockTimestamp
    }
  }
`;
