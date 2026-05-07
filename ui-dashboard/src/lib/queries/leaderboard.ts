/**
 * GraphQL queries for the /leaderboard page.
 *
 * Hosted Hasura caps results at 1000 rows per query and disables
 * `_aggregate` queries (count/sum/avg fields), so all aggregation we need
 * has to be either pre-rolled in the indexer or summed client-side.
 *
 * Hero tiles (total volume / unique traders / top-N concentration) read
 * the pre-rolled `LeaderboardWindowSnapshot` (or v2 sibling) plus a
 * small today-partial direct query — both bounded well under 1000 rows.
 *
 * The top-50 leaderboard table still reads `TraderDailySnapshot` directly
 * with `limit: 1000` (the lemma below): top-50 by window-sum is a subset
 * of top-1000 by single-day volume in any reasonable trader distribution.
 */

/**
 * Top trader-day rows by volume in a window. The 1000-row cap is fine for
 * the top-50 table because a trader who would crack the top-50 by summed
 * window-volume necessarily has at least one daily row in the top-1000 by
 * single-day volume. Long-tail $100/day regulars don't displace
 * top-of-list. (Hero tiles, which sum across ALL traders, read the
 * pre-rolled LeaderboardWindowSnapshot instead — see below.)
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

/**
 * Top legacy-v2 trader-day rows by volume. Source: BrokerTraderDailySnapshot,
 * which the broker handler only writes when `routedViaV3Router=false` — so
 * these are *broker-direct* swaps (Mento UI/SDK + third-party aggregators
 * still routing through the legacy Broker). The leaderboard's `venue=v2`
 * tab uses this to surface migration-outreach targets: who's still on v2.
 *
 * No `feesPaidUsdWei`/`uniquePools` (the v2 entity doesn't carry them — see
 * schema.graphql comment on BrokerTraderDailySnapshot for why).
 */
export const BROKER_TRADER_DAILY_TOP = /* GraphQL */ `
  query BrokerTraderDailyTop(
    $afterTimestamp: numeric!
    $isSystemAddressIn: [Boolean!]!
    $limit: Int!
  ) {
    BrokerTraderDailySnapshot(
      where: {
        timestamp: { _gte: $afterTimestamp }
        isSystemAddress: { _in: $isSystemAddressIn }
      }
      order_by: [{ volumeUsdWei: desc }, { id: asc }]
      limit: $limit
    ) {
      id
      chainId
      trader
      timestamp
      swapCount
      volumeUsdWei
      isSystemAddress
      lastSeenTimestamp
    }
  }
`;

/**
 * Top legacy-v2 aggregator-day rows by volume. The "unknown" bucket here is
 * the curation backlog: any large unknown row is a router we should classify
 * in `indexer-envio/config/aggregators.json` and ideally an integrator we
 * should reach out to about migrating to v3.
 *
 * No system-address filter — `aggregator` is already a canonical name; the
 * `system` value covers Mento internals and is naturally tiny.
 */
export const BROKER_AGGREGATOR_DAILY_TOP = /* GraphQL */ `
  query BrokerAggregatorDailyTop($afterTimestamp: numeric!, $limit: Int!) {
    BrokerAggregatorDailySnapshot(
      where: { timestamp: { _gte: $afterTimestamp } }
      order_by: [{ volumeUsdWei: desc }, { id: asc }]
      limit: $limit
    ) {
      id
      chainId
      aggregator
      lastSeenAggregatorAddress
      timestamp
      swapCount
      uniqueTraders
      volumeUsdWei
    }
  }
`;

// ---------------------------------------------------------------------------
// Pre-rolled hero metrics. `distinct_on: [chainId]` returns the LATEST
// snapshotDay per chain (most recent finalized hero card); the dashboard
// adds today's partial from the small TraderDailySnapshot query below.
// ---------------------------------------------------------------------------

export const LEADERBOARD_WINDOW_LATEST = /* GraphQL */ `
  query LeaderboardWindowLatest($windowKey: String!) {
    LeaderboardWindowSnapshot(
      where: { windowKey: { _eq: $windowKey } }
      order_by: [{ chainId: asc }, { snapshotDay: desc }]
      distinct_on: [chainId]
      limit: 100
    ) {
      id
      chainId
      windowKey
      snapshotDay
      windowStartDay
      totalVolumeUsdWei
      totalVolumeUsdWeiIncludingSystem
      totalSwapCount
      totalSwapCountIncludingSystem
      uniqueTraders
      uniqueTradersIncludingSystem
    }
  }
`;

export const BROKER_LEADERBOARD_WINDOW_LATEST = /* GraphQL */ `
  query BrokerLeaderboardWindowLatest($windowKey: String!) {
    BrokerLeaderboardWindowSnapshot(
      where: { windowKey: { _eq: $windowKey } }
      order_by: [{ chainId: asc }, { snapshotDay: desc }]
      distinct_on: [chainId]
      limit: 100
    ) {
      id
      chainId
      windowKey
      snapshotDay
      windowStartDay
      totalVolumeUsdWei
      totalVolumeUsdWeiIncludingSystem
      totalSwapCount
      totalSwapCountIncludingSystem
      uniqueTraders
      uniqueTradersIncludingSystem
    }
  }
`;

/**
 * Today's partial — added on top of the snapshot's [windowStart, yesterday]
 * total to keep hero numbers current to the minute. Today's
 * TraderDailySnapshot rows are bounded by active-traders-today: Mento
 * peaks well under 200 distinct traders/day across all chains, so the
 * `limit: 1000` cap is a >5x safety margin. If a single day ever
 * saturates 1000, the hero volume tile will silently understate (no
 * cap-hit banner), which is the same blind spot as
 * BROKER_AGGREGATOR_DAILY_TOP — revisit cap detection then.
 */
export const LEADERBOARD_TODAY_TRADERS = /* GraphQL */ `
  query LeaderboardTodayTraders(
    $todayMidnight: numeric!
    $isSystemAddressIn: [Boolean!]!
  ) {
    TraderDailySnapshot(
      where: {
        timestamp: { _gte: $todayMidnight }
        isSystemAddress: { _in: $isSystemAddressIn }
      }
      limit: 1000
    ) {
      chainId
      trader
      volumeUsdWei
      swapCount
      isSystemAddress
    }
  }
`;

export const BROKER_LEADERBOARD_TODAY_TRADERS = /* GraphQL */ `
  query BrokerLeaderboardTodayTraders(
    $todayMidnight: numeric!
    $isSystemAddressIn: [Boolean!]!
  ) {
    BrokerTraderDailySnapshot(
      where: {
        timestamp: { _gte: $todayMidnight }
        isSystemAddress: { _in: $isSystemAddressIn }
      }
      limit: 1000
    ) {
      chainId
      trader
      volumeUsdWei
      swapCount
      isSystemAddress
    }
  }
`;
