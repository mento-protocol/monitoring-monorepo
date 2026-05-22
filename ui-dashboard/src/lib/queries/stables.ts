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

// Per-tx supply changes for the /stables changes table + leaderboard. The
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
      source
      kind
      counterparty
      caller
      txTo
      isSystemCaller
      amount
      txHash
      blockNumber
      blockTimestamp
    }
  }
`;

// V3 streams used to enrich the changes table for GBPm/CHFm/JPYm (deferred
// fully in PR1 indexer; net-only via day-over-day totalSupply diff until
// the V3 mint/burn breakdown follow-up lands). These queries are kept thin
// so the merge step on the client doesn't pull source-specific bloat.
export const STABLES_V3_TROVE_OPS = `
  query StablesV3TroveOps(
    $chainId: Int!
    $sinceTimestamp: numeric!
    $limit: Int!
  ) {
    TroveOperationEvent(
      where: {
        chainId: { _eq: $chainId }
        timestamp: { _gte: $sinceTimestamp }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id
      instanceId
      timestamp
      owner
      debtBefore
      debtAfter
      debtChange
      operation
      txHash
      blockNumber
    }
  }
`;
