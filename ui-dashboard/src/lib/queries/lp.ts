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
 * "unique LPs" tile. Paginated via `fetchAllLpAddressPages` using the
 * canonical `fetchPaginatedRows` helper (page size 1 000).
 *
 * **Caveat:** offset pagination on an append-only table is not perfectly
 * stable under concurrent inserts — a new position row arriving between
 * pages can shift offsets and produce a duplicate or omission. Dedup by
 * `address.toLowerCase()` in the fetcher collapses duplicates; omissions
 * are rare and self-heal on the next poll. A proper fix is keyset
 * pagination — tracked as a follow-up.
 */
export const UNIQUE_LP_ADDRESSES = `
  query UniqueLpAddresses($poolIds: [String!]!, $limit: Int!, $offset: Int!) {
    LiquidityPosition(
      where: { poolId: { _in: $poolIds }, netLiquidity: { _gt: "0" } }
      limit: $limit
      offset: $offset
    ) {
      address
    }
  }
`;
