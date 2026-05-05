/**
 * GraphQL queries for the /leaderboard page.
 *
 * Hosted Hasura caps results at 1000 rows per query and disables
 * `_aggregate` (see `feedback_no_hasura_aggregates`), so all aggregation is
 * client-side over the indexer's pre-rolled snapshot entities. The window
 * `_gte` filter is applied in Hasura; the per-trader summing happens in
 * `lib/leaderboard.ts`.
 */

/**
 * Top trader-day rows by volume in a window. The 1000-row cap is fine for
 * an MVP top-50 ranking: a trader who would crack the top-50 by summed
 * window-volume necessarily has at least one daily row in the top-1000 by
 * single-day volume in any reasonable distribution. Long-tail $100/day
 * regulars don't displace top-of-list.
 */
export const TRADER_DAILY_TOP = /* GraphQL */ `
  query TraderDailyTop(
    $afterTimestamp: numeric!
    $isSystemAddressIn: [Boolean!]!
    $limit: Int!
  ) {
    TraderDailySnapshot(
      where: {
        timestamp: { _gte: $afterTimestamp }
        isSystemAddress: { _in: $isSystemAddressIn }
      }
      order_by: { volumeUsdWei: desc }
      limit: $limit
    ) {
      id
      chainId
      trader
      timestamp
      swapCount
      uniquePools
      volumeUsdWei
      feesPaidUsdWei
      isSystemAddress
      lastSeenTimestamp
    }
  }
`;

/**
 * Per-pool breakdown for a single trader over a window. Drives the
 * leaderboard's per-row expand and the flow-badge imbalance computation
 * (which needs each pool's inflow/outflow split to score the trader's
 * primary pool).
 *
 * Ordered by `volumeUsdWei desc` (not `timestamp desc`): a busy trader can
 * have >1000 pool-day rows in a 30d/all window, and the row that becomes
 * "primary pool" for the flow badge is the largest-volume pool aggregated
 * across the window. Ordering by recency would let an old high-volume pool
 * day fall outside the cap and silently misclassify the trader's flow.
 */
export const TRADER_POOL_DAILY_FOR_TRADER = /* GraphQL */ `
  query TraderPoolDailyForTrader(
    $chainId: Int!
    $trader: String!
    $afterTimestamp: numeric!
  ) {
    TraderPoolDailySnapshot(
      where: {
        chainId: { _eq: $chainId }
        trader: { _eq: $trader }
        timestamp: { _gte: $afterTimestamp }
      }
      order_by: [{ volumeUsdWei: desc }, { timestamp: desc }]
      limit: 1000
    ) {
      id
      chainId
      trader
      poolId
      timestamp
      swapCount
      volumeUsdWei
      inflowToken0UsdWei
      outflowToken0UsdWei
      inflowToken1UsdWei
      outflowToken1UsdWei
      feesPaidUsdWei
    }
  }
`;

/**
 * Pool metadata for resolving poolId → display name. Mento has ~30 pools
 * total, well under the 1000-row cap. Loaded once and joined client-side.
 */
export const POOLS_FOR_LEADERBOARD = /* GraphQL */ `
  query PoolsForLeaderboard {
    Pool(limit: 1000) {
      id
      chainId
      token0
      token1
    }
  }
`;

/**
 * Trader-pool-day rows in a window, used to drive the per-pool stacked
 * volume chart on `/leaderboard`. The dashboard sums these client-side
 * by `(poolId, day)` to produce one series per pool — pre-rolling
 * `PoolDailyVolumeSnapshot` at the indexer level is the proper fix
 * (`BACKLOG.md` PR 4) but client-side aggregation is fine for the MVP
 * given the 1000-row cap is rarely hit at 7d/30d.
 *
 * Ordered by `volumeUsdWei desc` so the cap, when hit, drops the
 * smallest contributors — the top-5 pools that drive the stacked chart's
 * visual signal stay intact.
 *
 * `trader` is selected so the page can intersect rows against the
 * non-system trader allowlist client-side when the system toggle is
 * off — `TraderPoolDailySnapshot` doesn't carry an `isSystemAddress`
 * column of its own (indexer schema doesn't snapshot it on this
 * entity), so we can't push the filter into Hasura. PR 4's
 * `PoolDailyVolumeSnapshot` rollup will fix this properly.
 */
export const POOL_DAILY_VOLUME = /* GraphQL */ `
  query PoolDailyVolume($afterTimestamp: numeric!, $limit: Int!) {
    TraderPoolDailySnapshot(
      where: { timestamp: { _gte: $afterTimestamp } }
      order_by: [{ volumeUsdWei: desc }, { timestamp: desc }, { id: asc }]
      limit: $limit
    ) {
      id
      chainId
      trader
      poolId
      timestamp
      volumeUsdWei
    }
  }
`;
