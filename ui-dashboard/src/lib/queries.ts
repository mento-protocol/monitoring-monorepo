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
      deviationBreachStartedAt
      lpFee
      protocolFee
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      referenceRateFeedID
      swapCount
      rebalanceCount
      notionalVolume0
      notionalVolume1
      reserves0
      reserves1
      healthTotalSeconds
      hasHealthData
    }
  }
`;

// Per-pool breach rollup counters, scoped to a chain. Kept OFF the
// shared ALL_POOLS_WITH_HEALTH query on purpose: these fields are
// deployed in a phased indexer rollout, and a schema-lag fail would
// blank every consumer of ALL_POOLS_WITH_HEALTH (the pool page, OG
// generation, the full pools table). Isolating them lets a failure
// degrade JUST the uptime column to "—" — same pattern as
// POOL_BREACH_ROLLUP on the single-pool page.
export const ALL_POOLS_BREACH_ROLLUP = `
  query AllPoolsBreachRollup($chainId: Int!) {
    Pool(where: { chainId: { _eq: $chainId } }) {
      id
      cumulativeCriticalSeconds
      breachCount
    }
  }
`;

// Slim query for building an oracle USD-rate map. Used by pages that only
// need to convert token amounts to USD (bridge-flows, pool-detail FX pairs)
// without loading the full 44-field pool payload. `buildOracleRateMap` reads
// exactly these fields — matching the Pick<> in its signature keeps the two
// in sync.
//
// The `oracleOk` filter matches `buildOracleRateMap`'s `if (pool.oracleOk
// === false) continue` semantics — include pools where oracleOk is `true`
// OR `null`. A plain `_eq: true` would exclude nulls (Hasura == SQL's
// three-valued NULL semantics), and during an indexer schema rollout
// pools with legacy rows can legitimately have `oracleOk: null` while
// carrying a valid `oraclePrice`; narrowing here would silently drop their
// rates from the map on affected chains.
export const ORACLE_RATES = `
  query OracleRates($chainId: Int!) {
    Pool(
      where: {
        chainId: { _eq: $chainId }
        _or: [
          { oracleOk: { _eq: true } }
          { oracleOk: { _is_null: true } }
        ]
      }
    ) {
      token0
      token1
      oraclePrice
      oracleOk
    }
  }
`;

export const RECENT_SWAPS = `
  query RecentSwaps($limit: Int!) {
    SwapEvent(
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
      reserves0
      reserves1
      healthTotalSeconds
      hasHealthData
    }
  }
`;

// Uptime / breach-count rollups. Isolated from POOL_DETAIL_WITH_HEALTH on
// purpose: these fields are brand-new on the indexer side, so during the
// deploy+resync window the hosted Hasura will reject them with "field not
// found". Keeping them in their own query means the pool page doesn't die
// — only the uptime tile degrades to "N/A". Uptime is sourced from the
// pool-level rollup (not the breach-row list) so the "% time critical"
// SLO stays accurate past Hasura's 1000-row cap on the breach list itself.
export const POOL_BREACH_ROLLUP = `
  query PoolBreachRollup($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id
      cumulativeBreachSeconds
      cumulativeCriticalSeconds
      breachCount
      deviationBreachStartedAt
    }
  }
`;

// Paginated + sortable breach history for the Breaches tab. `$orderBy`
// and `$where` let the server do the heavy lifting so pagination stays
// authoritative regardless of user-selected sort and duration filter.
// Isolated from POOL_DETAIL_WITH_HEALTH for the same reason
// POOL_BREACH_ROLLUP is — new entity type, resync window needs to land
// first.
export const POOL_DEVIATION_BREACHES_PAGE = `
  query PoolDeviationBreachesPage(
    $poolId: String!
    $limit: Int!
    $offset: Int!
    $orderBy: [DeviationThresholdBreach_order_by!]
    $where: DeviationThresholdBreach_bool_exp!
  ) {
    DeviationThresholdBreach(
      where: { _and: [{ poolId: { _eq: $poolId } }, $where] }
      order_by: $orderBy
      limit: $limit
      offset: $offset
    ) {
      id chainId poolId
      startedAt startedAtBlock
      endedAt endedAtBlock
      durationSeconds criticalDurationSeconds
      entryPriceDifference peakPriceDifference
      peakAt peakAtBlock
      startedByEvent startedByTxHash
      endedByEvent endedByTxHash endedByStrategy
      rebalanceCountDuring
    }
  }
`;

// Row-count for the Breaches-tab pagination. Hasura aggregates are
// disabled on hosted, so we fetch id-only rows up to ENVIO_MAX_ROWS and
// measure `.length` — same trick POOL_SWAPS_COUNT uses. Applies the
// active filter so page count reflects it.
export const POOL_DEVIATION_BREACHES_COUNT = `
  query PoolDeviationBreachesCount(
    $poolId: String!
    $where: DeviationThresholdBreach_bool_exp!
    $limit: Int!
  ) {
    DeviationThresholdBreach(
      where: { _and: [{ poolId: { _eq: $poolId } }, $where] }
      limit: $limit
    ) {
      id
    }
  }
`;

// Unpaginated feed for the scatter chart — chart shows FREQUENCY over
// time, so a page-sized slice would misrepresent it. Kept at 1000
// (Hasura's row cap) and reuses the same $where so the chart reflects
// whatever filter the table has applied.
export const POOL_DEVIATION_BREACHES_ALL = `
  query PoolDeviationBreachesAll(
    $poolId: String!
    $where: DeviationThresholdBreach_bool_exp!
  ) {
    DeviationThresholdBreach(
      where: { _and: [{ poolId: { _eq: $poolId } }, $where] }
      order_by: [{ startedAt: desc }]
      limit: 1000
    ) {
      id startedAt endedAt durationSeconds criticalDurationSeconds
      peakPriceDifference
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

// Fetches all TradingLimit rows for a chain. With 2 rows per FPMM pool (one
// per token), this stays well under Hasura's silent 1000-row cap for current
// pool counts. If pool count exceeds ~500 per chain, add pagination.
export const ALL_TRADING_LIMITS = `
  query AllTradingLimits($chainId: Int!) {
    TradingLimit(where: { chainId: { _eq: $chainId } }) {
      id poolId token limit0 limit1 decimals
      netflow0 netflow1
      lastUpdated0 lastUpdated1
      limitPressure0 limitPressure1
      limitStatus updatedAtBlock updatedAtTimestamp
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
