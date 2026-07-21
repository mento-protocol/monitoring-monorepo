// Single-pool detail extension, rollup, chart, and VirtualPool lifecycle
// queries. Re-exported from `../queries.ts` so existing
// `from "@/lib/queries"` imports stay stable.

import type { BiPoolExchangeRow, Pool } from "@/lib/types";

/** Response shape of `POOL_DETAIL_WITH_HEALTH`. Shared by the client `useGQL`
 *  read and the server SSR-prefetch fallback so their types can't drift.
 *  Lives here (not in the `server-only` SSR module) so client code can import
 *  it without pulling `server-only` into the browser bundle. */
export type PoolDetailResponse = { Pool: Pool[] };

export type PoolThresholdsKnownExtRow = {
  id: string;
  rebalanceThresholdAbove?: number | undefined;
  rebalanceThresholdBelow?: number | undefined;
  rebalanceThresholdsKnown?: boolean | undefined;
  tokenDecimalsKnown?: boolean | undefined;
  degenerateReserves?: boolean | undefined;
  breakerTripped?: boolean | undefined;
};
export type PoolThresholdsKnownExtResponse = {
  Pool: PoolThresholdsKnownExtRow[];
};

export type PoolVpOracleFreshnessExtRow = {
  id: string;
  oracleTimestamp?: string | undefined;
  oracleNumReporters?: number | undefined;
  tokenDecimalsKnown?: boolean | undefined;
  lastOracleReportAt?: string | undefined;
  medianLive?: boolean | undefined;
  oracleFreshnessWindow?: string | undefined;
  /** Client/server observation metadata; not part of the GraphQL selection. */
  vpOracleFreshnessCheckedAt?: number | undefined;
};
export type PoolVpOracleFreshnessExtResponse = {
  Pool: PoolVpOracleFreshnessExtRow[];
};

export type PoolVpDeprecationExtRow = {
  id: string;
  isDeprecated?: boolean | undefined;
  minimumReports?: string | undefined;
};
export type PoolVpDeprecationExtResponse = {
  BiPoolExchange: PoolVpDeprecationExtRow[];
};

export type PoolVpLifecycleDeprecationExtRow = {
  id: string;
  poolId?: string | undefined;
};
export type PoolVpLifecycleDeprecationExtResponse = {
  VirtualPoolLifecycle: PoolVpLifecycleDeprecationExtRow[];
};

export type PoolV2ExchangeResponse = {
  BiPoolExchange: BiPoolExchangeRow[];
};

export const POOL_DETAIL_WITH_HEALTH = `
  query PoolDetailWithHealth($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id chainId token0 token1 token0Decimals token1Decimals source
      wrappedExchangeId
      createdAtBlock createdAtTimestamp
      updatedAtBlock updatedAtTimestamp
      healthStatus
      oracleOk
      oraclePrice
      oracleTimestamp
      lastOracleReportAt
      oracleTxHash
      oracleExpiry
      oracleNumReporters
      referenceRateFeedID
      priceDifference
      rebalanceThreshold
      lastRebalancedAt
      deviationBreachStartedAt
      lpFee
      protocolFee
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      reserves0
      reserves1
      swapCount
      rebalanceCount
      notionalVolume0
      notionalVolume1
      healthTotalSeconds
      hasHealthData
    }
  }
`;

// Single-pool sibling of `ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN`. Same
// isolation rationale: keeps the data-trust / degenerate classification
// flags OFF the page's primary `POOL_DETAIL_WITH_HEALTH` query so a
// schema-lag during deploy degrades just the never-rebalance affordance,
// USD math, and degenerate health under-bound instead of breaking the
// entire pool detail page.
export const POOL_THRESHOLDS_KNOWN_EXT = `
  query PoolThresholdsKnownExt($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id
      rebalanceThresholdAbove
      rebalanceThresholdBelow
      rebalanceThresholdsKnown
      tokenDecimalsKnown
      degenerateReserves
      breakerTripped
    }
  }
`;

// Single-pool sibling of `ALL_POOLS_VP_ORACLE_FRESHNESS`. Kept separate from
// POOL_THRESHOLDS_KNOWN_EXT so new VP freshness schema-lag cannot drop
// unrelated trust/threshold fields.
// Keep the timestamp, quorum inputs, and freshness window in one Pool snapshot
// so the client observation time never certifies fields from an older query.
export const POOL_VP_ORACLE_FRESHNESS_EXT = `
  query PoolVpOracleFreshnessExt($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id
      oracleTimestamp
      oracleNumReporters
      tokenDecimalsKnown
      lastOracleReportAt
      medianLive
      oracleFreshnessWindow
    }
  }
`;

// Deprecated-wrapper state lives on BiPoolExchange, not Pool. Keep this as a
// tiny companion query so schema-lag in the v2 exchange entity degrades only the
// retired-wrapper UI suppression instead of the primary pool page.
export const POOL_VP_DEPRECATION_EXT = `
  query PoolVpDeprecationExt($id: String!, $chainId: Int!) {
    BiPoolExchange(
      where: {
        wrappedByPoolId: { _eq: $id }
        chainId: { _eq: $chainId }
      }
      limit: 1
    ) {
      id
      isDeprecated
      minimumReports
    }
  }
`;

export const POOL_VP_LIFECYCLE_DEPRECATION_EXT = `
  query PoolVpLifecycleDeprecationExt($id: String!, $chainId: Int!) {
    VirtualPoolLifecycle(
      where: {
        poolId: { _eq: $id }
        chainId: { _eq: $chainId }
        action: { _eq: "DEPRECATED" }
      }
      limit: 1
    ) {
      id
      poolId
    }
  }
`;

// Isolated from POOL_DETAIL_WITH_HEALTH (same rationale as POOL_BREACH_ROLLUP):
// new indexer field, hosted Hasura rejects it during the deploy+resync window,
// so the page survives and the reward tile degrades to "—".
export const POOL_CONFIG_EXT = `
  query PoolConfigExt($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id
      rebalanceReward
    }
  }
`;

// A pool may authorize more than one strategy simultaneously (Polygon's
// EURm/EUROP pool added Open after launching with Reserve). Keep this isolated
// from POOL_DETAIL_WITH_HEALTH so the detail page survives the indexer
// deploy+resync window and falls back to Pool.rebalancerAddress meanwhile.
export type PoolLiquidityStrategiesResponse = {
  PoolLiquidityStrategy: import("@/lib/types").PoolLiquidityStrategy[];
};

export const POOL_LIQUIDITY_STRATEGIES = `
  query PoolLiquidityStrategies($poolId: String!, $chainId: Int!) {
    PoolLiquidityStrategy(
      where: {
        poolId: { _eq: $poolId }
        chainId: { _eq: $chainId }
        active: { _eq: true }
      }
      order_by: [{ kind: asc }, { strategyAddress: asc }]
      limit: 20
    ) {
      id
      chainId
      poolId
      strategyAddress
      kind
      active
      addedAtBlock
      addedAtTimestamp
      updatedAtBlock
      updatedAtTimestamp
    }
  }
`;

// Isolated from POOL_DETAIL_WITH_HEALTH because RateFeed is a new indexer
// entity. During the hosted deploy+resync window Hasura may reject the type;
// the config panel should keep rendering and degrade only Oracle Source.
export const POOL_RATE_FEED_EXT = `
  query PoolRateFeedExt($chainId: Int!, $feedAddress: String!) {
    RateFeed(
      where: {
        chainId: { _eq: $chainId }
        feedAddress: { _eq: $feedAddress }
      }
      limit: 1
    ) {
      id
      chainId
      feedAddress
      pair
      reporterTypes
    }
  }
`;

// VirtualPool -> BiPoolExchange reverse-join. Replaces the temporary
// /api/v2-exchange-config route from PR #359; reads the indexer's
// `BiPoolExchange` entity directly via the `wrappedByPoolId` back-reference
// stamped at VirtualPoolDeployed (or in BiPoolManager.ExchangeCreated for
// the rare exchange-after-VP ordering). Isolated query (same isolation
// pattern as POOL_CONFIG_EXT / POOL_BREACH_ROLLUP) — the entity ships as
// part of the Phase 2 indexer deploy, so during the build+resync window
// hosted Hasura rejects the type as "field not found"; the rest of the
// pool page keeps rendering and just the v2 panel degrades to "—".
//
// Reverse-key on poolId rather than forward-key on `Pool.wrappedExchangeId`
// so the dashboard doesn't have to plumb `wrappedExchangeId` through the
// big POOL_DETAIL_WITH_HEALTH query (one less field to add to the
// deploy-window failure surface). Result set is always <=1 row so the
// non-indexed `wrappedByPoolId` filter is fine — small cardinality.
export const POOL_V2_EXCHANGE = `
  query PoolV2Exchange($poolId: String!, $chainId: Int!) {
    BiPoolExchange(
      where: {
        wrappedByPoolId: { _eq: $poolId }
        chainId: { _eq: $chainId }
      }
      limit: 1
    ) {
      id
      chainId
      exchangeId
      exchangeProvider
      asset0
      asset1
      pricingModule
      pricingModuleName
      spread
      referenceRateFeedID
      referenceRateResetFrequency
      minimumReports
      stablePoolResetSize
      bucket0
      bucket1
      lastBucketUpdate
      isDeprecated
      wrappedByPoolId
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
      breachCount
      healthBinarySeconds
      healthTotalSeconds
    }
  }
`;

// Cursor for projecting the currently open health interval. Isolated from
// POOL_BREACH_ROLLUP so schema lag on these newer fields leaves the stored
// all-time uptime counters available.
export const POOL_HEALTH_CURSOR = `
  query PoolHealthCursor($id: String!, $chainId: Int!) {
    Pool(where: { id: { _eq: $id }, chainId: { _eq: $chainId } }) {
      id
      lastOracleSnapshotTimestamp
      lastDeviationRatio
      lastOracleReportAt
      oracleExpiry
    }
  }
`;

// 7d-window anchor for the Uptime tile's "X.XX% last 7d" subtitle. Isolated
// from POOL_BREACH_ROLLUP so a hosted-Hasura schema lag on the new
// `cumulativeHealth*` fields degrades JUST the 7d subtitle to "—" — the
// all-time line stays rendered. Same isolation pattern as POOL_BREACH_ROLLUP
// itself uses against POOL_DETAIL_WITH_HEALTH.
export const POOL_HEALTH_7D_ANCHOR = `
  query PoolHealth7dAnchor($id: String!, $chainId: Int!, $sevenDaysAgo: numeric!) {
    PoolDailySnapshot(
      where: {
        poolId: { _eq: $id }
        chainId: { _eq: $chainId }
        timestamp: { _lte: $sevenDaysAgo }
      }
      order_by: [{ timestamp: desc }]
      limit: 1
    ) {
      timestamp
      cumulativeHealthBinarySeconds
      cumulativeHealthTotalSeconds
    }
  }
`;

// Single-row lookup of the *open* breach for a pool, keyed off the
// `pool.deviationBreachStartedAt` anchor. Returns just the trip tx hash so
// the DeviationCell can link "breach Xh ago" to the explorer. We can't fold
// this into POOL_BREACH_ROLLUP because the rollup is on the Pool entity
// (scalars only) — the tx hash lives on the DeviationThresholdBreach row.
export const POOL_OPEN_BREACH_TX = `
  query PoolOpenBreachTx(
    $poolId: String!
    $startedAt: numeric!
  ) {
    DeviationThresholdBreach(
      where: {
        poolId: { _eq: $poolId }
        startedAt: { _eq: $startedAt }
      }
      limit: 1
    ) {
      startedByTxHash
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
      entryPriceDifference entryRebalanceThreshold
      peakPriceDifference peakAt peakAtBlock
      startedByEvent startedByTxHash
      endedByEvent endedByTxHash endedByStrategy
      rebalanceCountDuring
    }
  }
`;

// Row-count for the Breaches-tab pagination. Hasura aggregates are
// disabled on hosted, so we fetch id-only rows up to ENVIO_MAX_ROWS and
// measure `.length`. Applies the active filter so page count reflects it.
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
      peakPriceDifference entryRebalanceThreshold
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

// Hourly PoolSnapshot rows for short hero-chart windows. The timestamp filter
// keeps 7d/30d responses under hosted Hasura's 1000-row cap.
export const POOL_HOURLY_SNAPSHOTS_CHART = `
  query PoolHourlySnapshotsChart($poolId: String!, $from: numeric!) {
    PoolSnapshot(
      where: { poolId: { _eq: $poolId }, timestamp: { _gte: $from } }
      order_by: [{ timestamp: asc }, { id: asc }]
      limit: 1000
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

// VirtualPool deploy/deprecate timeline. The DEPLOYED row exists for every
// pool (factory always emits it); DEPRECATED is appended when governance
// removes the underlying v2 exchange. Sorted asc so the UI can show
// "Deployed -> Deprecated" in chronological order without resorting.
export const VIRTUAL_POOL_LIFECYCLE = `
  query VirtualPoolLifecycle($poolId: String!) {
    VirtualPoolLifecycle(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockTimestamp: asc }
    ) {
      id
      action
      factoryAddress
      txHash
      blockNumber
      blockTimestamp
    }
  }
`;
