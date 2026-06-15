// LP-position queries (LiquidityPosition entity). The barrel re-export lives
// in `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.
import { SNAPSHOT_PAGE_SIZE } from "@/lib/network-fetcher/constants";

// Preferred LP ownership query. Environments without LiquidityPosition should
// show a migration message rather than attempt a correctness-risky fallback.

export const POOL_LP_POSITIONS = `
  query PoolLpPositions($poolId: String!) {
    LiquidityPosition(
      where: { poolId: { _eq: $poolId } }
      order_by: { netLiquidity: desc }
      limit: ${SNAPSHOT_PAGE_SIZE}
    ) {
      id address netLiquidity lastUpdatedBlock lastUpdatedTimestamp
    }
  }
`;

/**
 * Distinct LP addresses across the given pools, used to size the homepage
 * "unique LPs" tile. Paginated via `fetchAllLpAddressPages` using the
 * canonical `fetchPaginatedRows` helper.
 *
 * `order_by: {id: asc}` gives offset pagination a stable sort so consecutive
 * pages neither overlap nor skip rows under concurrent inserts.
 */
export const UNIQUE_LP_ADDRESSES = `
  query UniqueLpAddresses($poolIds: [String!]!, $limit: Int!, $offset: Int!) {
    LiquidityPosition(
      where: { poolId: { _in: $poolIds }, netLiquidity: { _gt: "0" } }
      order_by: { id: asc }
      limit: $limit
      offset: $offset
    ) {
      address
    }
  }
`;
