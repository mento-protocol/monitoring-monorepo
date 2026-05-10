// Pool list + per-pool event/snapshot/breach queries. The barrel re-export
// lives in `../queries.ts` so existing `from "@/lib/queries"` imports stay
// stable; consumers can also import directly from this module.

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
      wrappedExchangeId
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
      breachCount
      healthBinarySeconds
      healthTotalSeconds
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

// Pool label lookup — `id` (multichain `${chainId}-${address}`) plus the
// minimum fields needed to render `poolName()` and the FPMM/Virtual badge on
// the per-pool revenue leaderboard. No `oracleOk` filter: paused FX pools
// must still resolve to readable labels for their historical fee transfers.
// Explicit `limit: 1000` matches the hosted Hasura silent cap so the literal
// reflects the real ceiling (per chain, pool count is well under that today).
export const POOL_LABELS_ALL = `
  query PoolLabelsAll($chainId: Int!) {
    Pool(where: { chainId: { _eq: $chainId } }, limit: 1000) {
      id
      token0
      token1
      source
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
      order_by: { blockNumber: desc }
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
      improvement rebalanceThreshold effectivenessRatio
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
      improvement rebalanceThreshold effectivenessRatio
    }
  }
`;

// Isolated from POOL_REBALANCES_PAGE (same rationale as POOL_CONFIG_EXT):
// new indexer fields, hosted Hasura rejects them during the deploy+resync
// window, so the Rebalances tab survives and the Reward column degrades
// to "—" instead of the whole tab erroring. Looked up by row id so the
// shape mirrors whatever page the main query returned.
export const POOL_REBALANCES_USD_EXT = `
  query PoolRebalancesUsdExt($ids: [String!]!) {
    RebalanceEvent(where: { id: { _in: $ids } }) {
      id amount0Delta amount1Delta rewardBps notionalUsd rewardUsd
    }
  }
`;

// Lightweight full-history fetch of rewardUsd values for percentile-based
// outlier highlighting in the Rebalances table. Isolated like
// POOL_REBALANCES_USD_EXT so a Hasura schema-lag during deploy degrades to
// "no highlighting" instead of breaking the tab.
export const POOL_REBALANCE_REWARDS = `
  query PoolRebalanceRewards($poolId: String!, $limit: Int!) {
    RebalanceEvent(
      where: { poolId: { _eq: $poolId } }
      limit: $limit
      order_by: [{ blockNumber: desc }, { id: asc }]
    ) {
      rewardUsd
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
      wrappedExchangeId
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
      lpFee
      protocolFee
      limitStatus
      limitPressure0
      limitPressure1
      rebalancerAddress
      reserves0
      reserves1
      swapCount
      healthTotalSeconds
      hasHealthData
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

// VirtualPool → BiPoolExchange reverse-join. Replaces the temporary
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
// deploy-window failure surface). Result set is always ≤1 row so the
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
      peakPriceDifference entryRebalanceThreshold
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

// VirtualPool deploy/deprecate timeline. The DEPLOYED row exists for every
// pool (factory always emits it); DEPRECATED is appended when governance
// removes the underlying v2 exchange. Sorted asc so the UI can show
// "Deployed → Deprecated" in chronological order without resorting.
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

// Per-event Broker.Swap rows for the v2 exchange backing a VirtualPool.
// Includes both v3-router-routed swaps (VirtualPool wrapper sibling rows)
// and v2-direct swaps — the dashboard chart renders them as two stacked
// series so users see the *full* trading-pair activity, not just the
// (small) v3-wrapper slice.
//
// We don't have a per-(chainId, exchangeId, day) snapshot entity yet
// (Phase 2 of the plan); for now the chart paginates the raw events and
// buckets them client-side. exchangeId is rare enough per chain that
// total row count stays well under Hasura's 1000-row cap for active
// exchanges. Order: timestamp desc + id desc so offset pagination is
// stable under concurrent inserts.
export const BROKER_SWAPS_BY_EXCHANGE_ID_PAGE = `
  query BrokerSwapsByExchangeId(
    $chainId: Int!
    $exchangeId: String!
    $limit: Int!
    $offset: Int!
  ) {
    BrokerSwapEvent(
      where: {
        chainId: { _eq: $chainId }
        exchangeId: { _eq: $exchangeId }
      }
      order_by: [{ blockTimestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      trader
      tokenIn
      tokenOut
      amountIn
      amountOut
      volumeUsdWei
      txTo
      routedViaV3Router
      txHash
      blockNumber
      blockTimestamp
    }
  }
`;

// Daily rollup of legacy v2 (Broker → BiPoolManager) volume on a chain. Filters
// out router-driven Broker.Swap events (the sibling-of-VirtualPool case where
// the v3 Router transitively invokes the Broker — counted as v3 already via
// VirtualPool.Swap). chainId is filtered server-side because only Celo has a
// Broker today; Monad returns 0 rows.
//
// `id` is selected so the paginated fetcher can dedup on the canonical key
// (offset pagination over an append-only table is not stable under concurrent
// inserts). The schema id is `{chainId}-{provider}-{router|direct}-{day}`,
// which uniquely identifies a row across providers — required because two
// providers can share `(timestamp, volumeUsdWei, swapCount)`.
export const BROKER_DAILY_SNAPSHOTS_ALL = `
  query BrokerDailySnapshotsAll($chainId: Int!, $limit: Int!, $offset: Int!) {
    BrokerDailySnapshot(
      where: {
        chainId: { _eq: $chainId }
        routedViaV3Router: { _eq: false }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      timestamp
      volumeUsdWei
      swapCount
    }
  }
`;
