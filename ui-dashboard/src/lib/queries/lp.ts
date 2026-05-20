// LP-position queries (LiquidityPosition entity). The barrel re-export lives
// in `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

// Preferred LP ownership query. Environments without LiquidityPosition should
// show a migration message rather than attempt a correctness-risky fallback.
const POOL_LP_POSITIONS_LIMIT = 1000;

export const POOL_LP_POSITIONS = `
  query PoolLpPositions($poolId: String!) {
    LiquidityPosition(
      where: { poolId: { _eq: $poolId } }
      order_by: { netLiquidity: desc }
      limit: ${POOL_LP_POSITIONS_LIMIT}
    ) {
      id address netLiquidity lastUpdatedBlock lastUpdatedTimestamp
    }
  }
`;

/**
 * Distinct LP addresses across the given pools, used to size the homepage
 * "unique LPs" tile. Nominally capped at 10 000.
 *
 * **Caveat:** hosted Hasura silently caps every UI query at 1 000 rows
 * regardless of the literal limit (see `AGENTS.md` §"Recurring patterns").
 * Once any chain crosses 1 000 active LP positions, the global LP count
 * will silently undercount. Tracked for follow-up: paginate with the
 * `fetchAllSnapshotPages` pattern or switch to a pre-rolled `LpRollup`
 * entity on the indexer side.
 */
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
