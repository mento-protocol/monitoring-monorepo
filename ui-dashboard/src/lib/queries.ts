export const ALL_POOLS_WITH_HEALTH = `
  query AllPoolsWithHealth($chainId: Int!) {
    Pool(
      where: { chainId: { _eq: $chainId } }
      order_by: { createdAtBlock: desc }
    ) {
      id
      chainId
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
      healthTotalSeconds
      healthBinarySeconds
      lastOracleSnapshotTimestamp
      lastDeviationRatio
      hasHealthData
    }
  }
`;

// WARNING: Envio's hosted Hasura silently caps results at 1000 rows regardless
// of the requested limit. The `limit: 100000` is honored by self-hosted /
// local Hasura (no such cap), so the explicit value stays high for the
// benefit of dev/local envs. On hosted, this query returns at most 1000
// rows per call — safe for 24h windows today, risky for 7d/30d as protocol
// activity grows. For paginated / truncation-safe fetches use
// `fetchAllSnapshotPages` in `src/hooks/use-all-networks-data.ts`
// (paginates via POOL_SNAPSHOTS_ALL).
export const POOL_SNAPSHOTS_WINDOW = `
  query PoolSnapshotsWindow($from: numeric!, $to: numeric!, $poolIds: [String!]!) {
    PoolSnapshot(
      where: {
        timestamp: { _gte: $from, _lt: $to }
        poolId: { _in: $poolIds }
      }
      order_by: { timestamp: desc }
      limit: 100000
    ) {
      poolId
      timestamp
      reserves0
      reserves1
      swapCount
      swapVolume0
      swapVolume1
    }
  }
`;

// Envio's hosted Hasura silently caps every query at 1000 rows regardless of
// the requested limit. To fetch full history we must paginate with $offset;
// the hook's fetchAllSnapshotPages wrapper handles the loop.
//
// Order includes `id` as a deterministic tiebreaker — multiple pools' hourly
// snapshots share the same UTC-hour timestamp, and without a unique secondary
// sort key Postgres tie ordering isn't stable across paginated requests,
// which would duplicate or skip rows at page boundaries.
export const POOL_SNAPSHOTS_ALL = `
  query PoolSnapshotsAll($poolIds: [String!]!, $limit: Int!, $offset: Int!) {
    PoolSnapshot(
      where: { poolId: { _in: $poolIds } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      poolId
      timestamp
      reserves0
      reserves1
      swapCount
      swapVolume0
      swapVolume1
    }
  }
`;

export const RECENT_SWAPS = `
  query RecentSwaps($chainId: Int!, $limit: Int!) {
    SwapEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: { blockNumber: desc }
      limit: $limit
    ) {
      id chainId poolId sender recipient
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
      id chainId poolId sender recipient
      amount0In amount1In amount0Out amount1Out
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_SWAPS_PAGE = `
  query PoolSwapsPage($poolId: String!, $limit: Int!, $offset: Int!, $orderBy: [SwapEvent_order_by!]!) {
    SwapEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId poolId sender recipient
      amount0In amount1In amount0Out amount1Out
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_SWAPS_COUNT = `
  query PoolSwapsCount($poolId: String!, $limit: Int!, $offset: Int!) {
    SwapEvent(where: { poolId: { _eq: $poolId } }, limit: $limit, offset: $offset) {
      id
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
      id chainId reserve0 reserve1
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
      id chainId sender caller priceDifferenceBefore priceDifferenceAfter
      txHash blockNumber blockTimestamp
      improvement effectivenessRatio
    }
  }
`;

export const POOL_REBALANCES_PAGE = `
  query PoolRebalancesPage($poolId: String!, $limit: Int!, $offset: Int!, $orderBy: [RebalanceEvent_order_by!]!) {
    RebalanceEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId sender caller priceDifferenceBefore priceDifferenceAfter
      txHash blockNumber blockTimestamp
      improvement effectivenessRatio
    }
  }
`;

export const POOL_REBALANCES_COUNT = `
  query PoolRebalancesCount($poolId: String!, $limit: Int!, $offset: Int!) {
    RebalanceEvent(where: { poolId: { _eq: $poolId } }, limit: $limit, offset: $offset) {
      id
    }
  }
`;

/**
 * Latest rebalance tx for a pool scoped to a specific strategy. Used by the
 * pool header's Rebalance Status cell to attribute the "last Ns ago" link
 * to the ACTIVE strategy — unscoped lookups would return txs from rotated
 * strategies and link the wrong event under the current strategy label.
 *
 * `sender` is the strategy address on RebalanceEvent (the "Strategy" column
 * in the Rebalances tab). Pass lowercased; Envio stores addresses lowercase.
 */
export const LATEST_POOL_REBALANCE_FOR_STRATEGY = `
  query LatestPoolRebalanceForStrategy($poolId: String!, $strategy: String!) {
    RebalanceEvent(
      where: {
        poolId: { _eq: $poolId }
        sender: { _eq: $strategy }
      }
      order_by: { blockNumber: desc }
      limit: 1
    ) {
      txHash
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
      id chainId kind sender
      amount0 amount1 liquidity
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_LIQUIDITY_PAGE = `
  query PoolLiquidityPage($poolId: String!, $limit: Int!, $offset: Int!, $orderBy: [LiquidityEvent_order_by!]!) {
    LiquidityEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId kind sender
      amount0 amount1 liquidity
      txHash blockNumber blockTimestamp
    }
  }
`;

export const POOL_LIQUIDITY_COUNT = `
  query PoolLiquidityCount($poolId: String!, $limit: Int!, $offset: Int!) {
    LiquidityEvent(where: { poolId: { _eq: $poolId } }, limit: $limit, offset: $offset) {
      id
    }
  }
`;

export const POOL_DETAIL_WITH_HEALTH = `
  query PoolDetailWithHealth($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id chainId token0 token1 token0Decimals token1Decimals source
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
      deviationBreachStartedAt
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      rebalanceLivenessStatus
      reserves0
      reserves1
      healthTotalSeconds
      healthBinarySeconds
      lastOracleSnapshotTimestamp
      lastDeviationRatio
      hasHealthData
    }
  }
`;

export const POOL_SNAPSHOTS_CHART = `
  query PoolSnapshotsChart($poolId: String!) {
    PoolSnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: { timestamp: desc }
      limit: 50000
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

// Daily rollup of PoolSnapshot — one row per pool per UTC day. At ~365 rows per
// pool per year the full history fits in Hasura's 1000-row cap for ~2.7 years.
// Older pools lose oldest rows first — fetching newest-first means the chart
// always shows the most recent history and reverses client-side to chronological.
export const POOL_DAILY_SNAPSHOTS_CHART = `
  query PoolDailySnapshotsChart($poolId: String!) {
    PoolDailySnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: [{ timestamp: desc }, { id: desc }]
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

// Daily rollup across all pools on a chain — used for the homepage volume-over-time
// chart. Still paginated (across all pools the row count exceeds 1000 after a few
// years), but pagination cost is ~20× lower than the hourly cross-pool query.
export const POOL_DAILY_SNAPSHOTS_ALL = `
  query PoolDailySnapshotsAll($poolIds: [String!]!, $limit: Int!, $offset: Int!) {
    PoolDailySnapshot(
      where: { poolId: { _in: $poolIds } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      poolId
      timestamp
      reserves0
      reserves1
      swapCount
      swapVolume0
      swapVolume1
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
  query OracleSnapshots($poolId: String!, $limit: Int!, $offset: Int!, $orderBy: [OracleSnapshot_order_by!]!) {
    OracleSnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId
      poolId
      timestamp
      oraclePrice
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
      txHash
      deviationRatio
      healthBinaryValue
      hasHealthData
    }
  }
`;

// Separate query for charts — always fetches the most recent N snapshots
// ordered by timestamp desc, then reversed client-side for chronological display.
// Decoupled from table pagination so charts always show full history context.
export const ORACLE_SNAPSHOTS_CHART = `
  query OracleSnapshotsChart($poolId: String!, $limit: Int!) {
    OracleSnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: { timestamp: desc }
      limit: $limit
    ) {
      id chainId
      poolId
      timestamp
      oraclePrice
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
      txHash
      deviationRatio
      healthBinaryValue
      hasHealthData
    }
  }
`;

export const ORACLE_SNAPSHOTS_WINDOW = `
  query OracleSnapshotsWindow($poolId: String!, $from: numeric!, $to: numeric!, $limit: Int!) {
    OracleSnapshot(
      where: {
        poolId: { _eq: $poolId }
        timestamp: { _gte: $from, _lte: $to }
      }
      order_by: [{ timestamp: desc }, { blockNumber: desc }, { id: desc }]
      limit: $limit
    ) {
      id chainId
      poolId
      timestamp
      oraclePrice
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
      txHash
      deviationRatio
      healthBinaryValue
      hasHealthData
    }
  }
`;

export const ORACLE_SNAPSHOT_PREDECESSOR = `
  query OracleSnapshotPredecessor($poolId: String!, $before: numeric!) {
    OracleSnapshot(
      where: {
        poolId: { _eq: $poolId }
        timestamp: { _lt: $before }
      }
      order_by: [{ timestamp: desc }, { blockNumber: desc }, { id: desc }]
      limit: 1
    ) {
      id chainId
      poolId
      timestamp
      oraclePrice
      oracleOk
      numReporters
      priceDifference
      rebalanceThreshold
      source
      blockNumber
      txHash
      deviationRatio
      healthBinaryValue
      hasHealthData
    }
  }
`;

export const ORACLE_SNAPSHOTS_COUNT_PAGE = `
  query OracleSnapshotsCountPage($poolId: String!, $limit: Int!, $offset: Int!) {
    OracleSnapshot(where: { poolId: { _eq: $poolId } }, limit: $limit, offset: $offset) {
      id
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

export const OLS_LIQUIDITY_EVENTS = `
  query OlsLiquidityEvents($poolId: String!, $olsAddress: String!, $limit: Int!) {
    OlsLiquidityEvent(
      where: { poolId: { _eq: $poolId }, olsAddress: { _eq: $olsAddress } }
      order_by: { blockTimestamp: desc }
      limit: $limit
    ) {
      id chainId direction caller
      tokenGivenToPool amountGivenToPool
      tokenTakenFromPool amountTakenFromPool
      txHash blockNumber blockTimestamp
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
