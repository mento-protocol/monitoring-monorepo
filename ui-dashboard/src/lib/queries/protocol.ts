// Chain-wide protocol-fee snapshot queries. The barrel re-export lives in
// `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.
//
// PR-snapshot-3 retired `PROTOCOL_FEE_TRANSFERS_ALL`. All fee surfaces —
// chain-level KPI tile, fee chart, and per-pool leaderboard — now read
// from `POOL_DAILY_FEE_SNAPSHOTS_PAGE`.

/**
 * Paginated fetch of `PoolDailyFeeSnapshot` rows for one chain. Pool×day
 * cardinality (≈30 pools × 430 days at start of 2026 worst case) easily exceeds
 * the silent 1000-row Hasura cap, so consumers MUST loop with offset until a
 * page returns short. Tiebreaker `id: desc` gives deterministic ordering for
 * rows that share a `timestamp` (different pools on the same day).
 *
 * Selected fields are the minimum the dashboard aggregators need. The full
 * entity carries `allPegged`, `unresolvedCount`, `transferCount`, `blockNumber`,
 * `updatedAtTimestamp`, `poolId` — none of which are read here.
 */
export const POOL_DAILY_FEE_SNAPSHOTS_PAGE = `
  query PoolDailyFeeSnapshotsPage($chainId: Int!, $limit: Int!, $offset: Int!) {
    PoolDailyFeeSnapshot(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      chainId
      poolAddress
      timestamp
      tokens
      tokenSymbols
      tokenDecimals
      amounts
      feesUsdWei
    }
  }
`;
