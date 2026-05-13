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

// Per-pool data-trust flags — `rebalanceThresholdsKnown` triple
// (above/below/known) plus `tokenDecimalsKnown`. Kept OFF
// `ALL_POOLS_WITH_HEALTH` for the same schema-lag reason as
// `ALL_POOLS_BREACH_ROLLUP`: a deploy-window in which the dashboard ships
// the new fields before the prod indexer has them would otherwise reject
// the entire pools query. Isolating means consumers (`isNeverRebalance`,
// `effectiveThreshold` in `health.ts`, `getSnapshotVolumeInUsd` in
// `volume.ts`) degrade safely (10000-bps under-bound for thresholds, null
// USD volume for unknown decimals) until the merge lands.
//
// `rebalanceThresholdAbove` / `rebalanceThresholdBelow` ride alongside
// the Known flag because `isNeverRebalance` requires BOTH split sides to
// be 0 (the active `rebalanceThreshold` on the main query is just the
// side `pickActiveThreshold` chose at index time — can be 0 on an
// asymmetric `above=0, below>0` pool that DOES rebalance; see indexer
// `pool.ts:isNeverRebalance`). `tokenDecimalsKnown` distinguishes
// schema-default 18/18 from on-chain-trusted decimals so dashboard USD
// math doesn't silently scale a 6-dp USDC leg as 18-dp. Triggered by
// Cursor's learned rule "Isolate new Envio/Hasura entity fields in
// separate queries for schema-lag resilience".
export const ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN = `
  query AllPoolsRebalanceThresholdsKnown($chainId: Int!) {
    Pool(where: { chainId: { _eq: $chainId } }) {
      id
      rebalanceThresholdAbove
      rebalanceThresholdBelow
      rebalanceThresholdsKnown
      tokenDecimalsKnown
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
      lastOracleSnapshotTimestamp
      lastDeviationRatio
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
