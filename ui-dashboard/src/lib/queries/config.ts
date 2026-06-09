// Trading-limit, oracle-snapshot, and breaker-config queries. The barrel
// re-export lives in `../queries.ts` so existing `from "@/lib/queries"`
// imports stay stable; consumers can also import directly from this module.

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
      source
      blockNumber
      txHash
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
// landed today, the breaker would trip"). The update_reserves / rebalanced
// rows are pool-state snapshots rather than oracle median changes, so they
// are excluded from this breaker-band chart.
//
// Keyset-paginated: `timestamp: { _lt: $beforeTimestamp }` lets the chart
// scroll back past the 1000-row Hasura cap one page at a time (see
// `useWindowedHistory`). The newest window passes a far-future sentinel
// cursor; older pages pass the oldest-loaded timestamp. `order_by` carries
// an `id` tiebreaker so the ordering is deterministic when two medians share
// a timestamp.
//
// Known limitation (accepted): the cursor is timestamp-only (`_lt`), so if a
// 1000-row page boundary falls EXACTLY between two medians that share a unix
// second, the remaining same-second rows are skipped on the next page (a
// silent one-point gap, not a double-load — the id-dedup only prevents
// double-loads). A compound `(timestamp, id)` cursor would close it, but at
// oracle_median_updated cadence (~12/hr/pool) two medians in the same second
// AND straddling the page boundary is vanishingly unlikely, and the impact is
// one missing point on a read-only context chart. Revisit if the chart ever
// pages a higher-cadence source.
//
// `breakerBaselineAtSnapshot` / `breakerThresholdAtSnapshot` are now selected
// here directly (folded in from the former `ORACLE_SNAPSHOTS_CHART_BANDS_EXT`
// companion). The companion existed to isolate a hosted-Hasura schema-lag
// window when those fields first shipped (PR #631) — that window is long
// closed (both fields resolve on prod today), so the second round-trip is no
// longer worth it. Nullable for pre-deploy rows + unseeded EMA — the chart
// falls back to the current band in those cases.
export const ORACLE_SNAPSHOTS_CHART = `
  query OracleSnapshotsChart($poolId: String!, $limit: Int!, $beforeTimestamp: numeric!) {
    OracleSnapshot(
      where: {
        poolId: { _eq: $poolId }
        source: { _eq: "oracle_median_updated" }
        timestamp: { _lt: $beforeTimestamp }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id chainId
      poolId
      timestamp
      oraclePrice
      oracleOk
      numReporters
      source
      blockNumber
      txHash
      breakerBaselineAtSnapshot
      breakerThresholdAtSnapshot
    }
  }
`;

// Daily OHLC rollup of the oracle median price (one row per pool per UTC day),
// for the chart's zoomed-out resolution. Ordered `bucketStart` DESC so Hasura's
// 1000-row cap truncates the OLDEST days, not the newest — at daily granularity
// that's the most recent ~2.7 years (vs ~3.5 days for the raw
// `oracle_median_updated` feed). The consumer (`useOracleDailyCandles`) reverses
// to chronological ASC for the chart. `anyOutOfBand` is the precomputed breaker
// verdict (the chart colors candles from it directly); `maxDeviationRatio` can
// be the "-1" no-health-data sentinel. See `OraclePriceDailySnapshot` in
// indexer-envio/schema.graphql.
export const ORACLE_PRICE_DAILY = `
  query OraclePriceDaily($poolId: String!) {
    OraclePriceDailySnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: [{ bucketStart: desc }]
    ) {
      bucketStart
      openPrice
      highPrice
      lowPrice
      closePrice
      sampleCount
      anyOutOfBand
      maxDeviationRatio
      endBreakerBaselineAtSnapshot
      endBreakerThresholdAtSnapshot
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
      # Deterministic pick when a feed somehow ends up with multiple
      # trip-able breakers — pickTrippableConfig() returns the first
      # enabled non-MARKET_HOURS row, so the order matters.
      order_by: { id: asc }
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
