// LP-position queries (LiquidityPosition entity). The barrel re-export lives
// in `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

// Preferred LP ownership query. Environments without LiquidityPosition should
// show a migration message rather than attempt a correctness-risky fallback.
export const POOL_LP_POSITIONS = `
  query PoolLpPositions($poolId: String!) {
    LiquidityPosition(
      where: { poolId: { _eq: $poolId } }
      order_by: { netLiquidity: desc }
    ) {
      id address netLiquidity lastUpdatedBlock lastUpdatedTimestamp
    }
  }
`;

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
