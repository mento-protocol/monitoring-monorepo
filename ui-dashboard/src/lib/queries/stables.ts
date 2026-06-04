// GraphQL queries for the /stables dashboard page. Targets entities added in
// the parallel indexer PR (`StableSupplyDailySnapshot`, `V2StableSupplyChangeEvent`)
// — until that PR is deployed + re-synced, these queries return empty arrays.
//
// Pagination uses keyset on `(timestamp desc, id desc)` to break Hasura's
// 1000-row cap for the `All` range (~16 tokens × 365 days = ~5840 rows worst
// case). The query takes an optional `beforeTimestamp` cursor; pass the last
// page's earliest `timestamp` to fetch the next page.

export const STABLES_DAILY_SNAPSHOTS = `
  query StablesDailySnapshots(
    $chainId: Int!
    $limit: Int!
    $beforeTimestamp: numeric!
  ) {
    StableSupplyDailySnapshot(
      where: {
        chainId: { _eq: $chainId }
        timestamp: { _lt: $beforeTimestamp }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      source
      tokenDecimals
      timestamp
      totalSupply
      dailyMintAmount
      dailyBurnAmount
    }
  }
`;

// Latest snapshot per (chainId, tokenAddress) — used for the KPI strip's
// "current outstanding" totals + per-token sparkline-grid headlines. The
// indexer's sparse-day semantics mean this returns the LATEST row, not
// necessarily today's — UI surfaces stale dates accordingly.
//
// Hasura `distinct_on` is supported (verified via existing protocol-fees
// queries) and keeps the row count bounded to ~16 per chain.
//
// Invariant: each (chainId, tokenAddress) maps to exactly one `source`
// today — V2 cUSD-USDm and V3 hub USDm live at DISTINCT addresses
// (`0x765de8…` vs `0x106cc…`), and no other Mento stable has a sibling
// source. So `distinct_on: tokenAddress` returns the same set as the
// rollup's `(tokenAddress, source)` grouping. Indexer-side: enforced by
// `v2Stables/config.ts:_byAddress` (no duplicate-address keys).
export const STABLES_LATEST_PER_TOKEN = `
  query StablesLatestPerToken($chainId: Int!) {
    StableSupplyDailySnapshot(
      where: { chainId: { _eq: $chainId } }
      distinct_on: tokenAddress
      order_by: [{ tokenAddress: asc }, { timestamp: desc }]
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      source
      tokenDecimals
      timestamp
      totalSupply
      dailyMintAmount
      dailyBurnAmount
    }
  }
`;

// Per-tx supply changes for the /stables changes table + ranked table. The
// V3 streams (TroveOperationEvent / RedemptionEvent / LiquidationEvent) merge
// in on the client side — those carry source-specific fields that don't
// normalize cleanly into V2StableSupplyChangeEvent.
export const STABLES_V2_CHANGES = `
  query StablesV2Changes(
    $chainId: Int!
    $sinceTimestamp: numeric!
    $limit: Int!
    $offset: Int!
  ) {
    V2StableSupplyChangeEvent(
      where: {
        chainId: { _eq: $chainId }
        blockTimestamp: { _gte: $sinceTimestamp }
      }
      order_by: [{ blockTimestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      tokenDecimals
      source
      kind
      counterparty
      caller
      txTo
      isProtocolOwnedCaller
      amount
      txHash
      blockNumber
      blockTimestamp
    }
  }
`;

// V3 Liquity per-tx streams (`TroveOperationEvent`, `RedemptionEvent`,
// `LiquidationEvent`) will be merged into the changes table in PR2.5
// once the V3 mint/burn breakdown lands on the indexer. They're not
// declared here — add them alongside the consumer that needs them.
