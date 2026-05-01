// Pool list + per-pool event/snapshot/breach queries are extracted to ./queries/pools
// so this barrel can grow without breaking the per-domain organisation downstream.
// Re-exported here to keep existing `from "@/lib/queries"` imports stable.
export * from "./queries/pools";

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

// Per-pool breaker config + recent trip history. Keyed by rateFeedID (NOT
// pool ID) because a single feed underpins multiple pools (e.g.
// USDC/USDm + axlUSDC/USDm both use feed 0xa1a8…), so denormalising onto
// Pool would write-amplify on every breaker event. The dashboard fetches
// this in parallel with POOL_DETAIL_WITH_HEALTH and renders <BreakerPanel />
// only when the response is non-empty.
//
// Returns an array because, in principle, a feed could have multiple
// trip-able breakers; in production today every v3 feed has exactly one
// MedianDelta or ValueDelta plus the always-present MarketHours row (the
// latter has no per-feed config and is filtered client-side via
// `breaker.kind === "MARKET_HOURS"` to drive the title-row pill).
export const POOL_BREAKER_CONFIG = `
  query PoolBreakerConfig($chainId: Int!, $rateFeedID: String!) {
    BreakerConfig(
      where: {
        chainId: { _eq: $chainId }
        rateFeedID: { _eq: $rateFeedID }
      }
    ) {
      id
      enabled
      cooldownTime
      rateChangeThreshold
      smoothingFactor
      medianRatesEMA
      referenceValue
      lastMedianRate
      lastUpdatedAt
      status
      tradingMode
      lastStatusUpdatedAt
      cooldownEndsAt
      lastTripAt
      lastTripTxHash
      lastResetAt
      tripCountLifetime
      breaker {
        id
        address
        kind
        activatesTradingMode
        defaultCooldownTime
        defaultRateChangeThreshold
      }
    }
    BreakerTripEvent(
      where: {
        chainId: { _eq: $chainId }
        rateFeedID: { _eq: $rateFeedID }
      }
      order_by: [{ blockTimestamp: desc }]
      limit: 50
    ) {
      id
      blockTimestamp
      txHash
      medianRateAtTrip
      referenceAtTrip
      thresholdAtTrip
      breaker {
        address
        kind
      }
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
