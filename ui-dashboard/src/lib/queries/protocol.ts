// Chain-wide protocol-fee transfer queries. The barrel re-export lives in
// `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

/**
 * Fetch all protocol fee transfers for client-side USD aggregation.
 *
 * Hosted Envio Hasura silently caps every UI query at 1 000 rows regardless
 * of the literal `limit` (see `AGENTS.md` §"Recurring patterns"). The literal
 * here matches that cap so `aggregateProtocolFees().isTruncated` flips at the
 * real ceiling — otherwise the lower-bound badge stays hidden until 10 000
 * rows that prod will never deliver. Once any chain crosses 1 000 lifetime
 * fee-transfer rows, the revenue tiles correctly mark themselves as a lower
 * bound.
 *
 * Still consumed by the chain-level Swap Fees `BreakdownTile` and
 * `FeeOverTimeChart` on `/revenue`; the per-pool leaderboard moved to
 * `POOL_DAILY_FEE_SNAPSHOTS_PAGE` in PR-snapshot-2. Migrating the tile +
 * chart off raw transfers is deferred to PR-snapshot-3.
 */
export const PROTOCOL_FEE_TRANSFERS_ALL = `
  query ProtocolFeeTransfersAll($chainId: Int!) {
    ProtocolFeeTransfer(
      where: { chainId: { _eq: $chainId } }
      limit: 1000
      order_by: { blockTimestamp: desc }
    ) {
      chainId
      tokenSymbol
      tokenDecimals
      amount
      blockTimestamp
      from
    }
  }
`;

/**
 * Paginated fetch of `PoolDailyFeeSnapshot` rows for one chain. Pool×day
 * cardinality (≈30 pools × 430 days at start of 2026 worst case) easily exceeds
 * the silent 1000-row Hasura cap, so consumers MUST loop with offset until a
 * page returns short. Tiebreaker `id: desc` gives deterministic ordering for
 * rows that share a `timestamp` (different pools on the same day).
 *
 * Selected fields are the minimum the dashboard aggregator needs. The full
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
