// Trading-limit, oracle-snapshot, and breaker-config queries. The barrel
// re-export lives in `../queries.ts` so existing `from "@/lib/queries"`
// imports stay stable; consumers can also import directly from this module.

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
// Filter the chart to median-updated snapshots only. The indexer writes
// OracleSnapshot rows for four event types — each individual report
// (oracle_reported), each median rotation (oracle_median_updated), every
// reserves change (update_reserves), and every rebalance (rebalanced) —
// but the BreakerBox only evaluates trip conditions on MedianUpdated:
// a single outlier reporter that doesn't move the median never trips a
// breaker. Restricting the chart to oracle_median_updated keeps the
// band verdict semantically correct (a red point means "if this median
// landed today, the breaker would trip"). The update_reserves /
// rebalanced rows store pool-internal post-state deviation, not oracle
// deviation, so they're excluded for the same reason.
export const ORACLE_SNAPSHOTS_CHART = `
  query OracleSnapshotsChart($poolId: String!, $limit: Int!) {
    OracleSnapshot(
      where: {
        poolId: { _eq: $poolId }
        source: { _eq: "oracle_median_updated" }
      }
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

// The active deviation breaker for the pool's rate feed. There's typically
// one enabled MEDIAN_DELTA or VALUE_DELTA per feed (MARKET_HOURS is a
// schedule halt, not a deviation comparator — excluded here). All numeric
// fields ride as Fixidity 1e24 strings; divide by 1e24 to get the float.
export const BREAKER_CONFIG_FOR_RATE_FEED = `
  query BreakerConfigForRateFeed($rateFeedID: String!, $chainId: Int!) {
    BreakerConfig(
      where: {
        rateFeedID: { _eq: $rateFeedID }
        chainId: { _eq: $chainId }
        enabled: { _eq: true }
        breaker: { kind: { _neq: "MARKET_HOURS" } }
      }
      # Deterministic pick when a feed somehow ends up with two enabled
      # non-MARKET_HOURS breakers — the chart reads [0] downstream.
      order_by: { id: asc }
      limit: 2
    ) {
      id
      breaker { kind defaultRateChangeThreshold }
      rateChangeThreshold
      referenceValue
      medianRatesEMA
      lastMedianRate
      status
      lastTripAt
      cooldownTime
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

// `limit: 1` because a pool has exactly one creation tx; `FactoryDeployment`
// is append-only and indexed once per FPMM, so any extra rows would be
// duplicates worth surfacing as a bug, not paginating through.
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
