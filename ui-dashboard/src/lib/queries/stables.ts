// GraphQL queries for the /stables dashboard page. Targets entities added in
// the parallel indexer PR (`StableSupplyDailySnapshot`, `StableSupplyChangeEvent`)
// — until that PR is deployed + re-synced, these queries return empty arrays.
//
// Pagination uses keyset on `(timestamp desc, id desc)` to break Hasura's
// 1000-row cap for the `All` range across Celo + Monad stable rows. The query
// takes an optional `beforeTimestamp` cursor; pass the last
// page's earliest `timestamp` to fetch the next page.

export const STABLES_DAILY_SNAPSHOTS = `
  query StablesDailySnapshots(
    $chainIds: [Int!]!
    $limit: Int!
    $beforeTimestamp: numeric!
  ) {
    StableSupplyDailySnapshot(
      where: {
        chainId: { _in: $chainIds }
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

// Current running supply per (chainId, tokenAddress) — used for the KPI
// strip's "current outstanding" totals + per-token sparkline-grid headlines.
// Daily snapshots are sparse and only flush on later events crossing a UTC
// day; this state table is updated on every observed mint/burn event.
//
// Field aliases normalize the state row into the same shape as
// StableSupplyDailySnapshot so callers can merge it with the historical
// daily stream. `timestamp` is the current UTC day bucket, not the last event
// timestamp, because chart helpers consume day-bucketed rows.
export const STABLES_CURRENT_SUPPLY_PER_TOKEN = `
  query StablesCurrentSupplyPerToken($chainIds: [Int!]!) {
    StableTokenSupply(
      where: { chainId: { _in: $chainIds } }
      order_by: [{ chainId: asc }, { tokenAddress: asc }]
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      source
      tokenDecimals
      timestamp: currentDayBucket
      totalSupply
      dailyMintAmount: mintedTodayBucket
      dailyBurnAmount: burnedTodayBucket
    }
  }
`;

// Latest daily snapshot per (chainId, tokenAddress). Used as a fallback for
// supply rows that do not have StableTokenSupply state, currently Celo
// V3_LIQUITY rows derived from LiquityInstance.systemDebt.
//
// Hasura `distinct_on` is supported (verified via existing protocol-fees
// queries) and keeps the row count bounded.
//
// Invariant: each (chainId, tokenAddress) maps to exactly one `source`
// today — Celo cUSD-USDm and V3 hub USDm live at DISTINCT addresses
// (`0x765de8…` vs `0x106cc…`), and no other Mento stable has a sibling
// source on the same chain. So `distinct_on: [chainId, tokenAddress]`
// returns the same set as the rollup's `(chainId, tokenAddress, source)`
// grouping. Indexer-side: enforced by `stables/config.ts:_byAddress`
// (no duplicate-address keys).
export const STABLES_LATEST_PER_TOKEN = `
  query StablesLatestPerToken($chainIds: [Int!]!) {
    StableSupplyDailySnapshot(
      where: { chainId: { _in: $chainIds } }
      distinct_on: [chainId, tokenAddress]
      order_by: [{ chainId: asc }, { tokenAddress: asc }, { timestamp: desc }]
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

// Current custody state is one row per (chainId, tokenAddress): the indexer
// schema keys StableTokenCustodyState as "{chainId}-{tokenAddress}". The
// explicit ordering keeps the UI merge deterministic; no distinct_on is needed.
export const STABLES_CURRENT_CUSTODY_PER_TOKEN = `
  query StablesCurrentCustodyPerToken($chainIds: [Int!]!) {
    StableTokenCustodyState(
      where: { chainId: { _in: $chainIds } }
      order_by: [{ chainId: asc }, { tokenAddress: asc }]
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      source
      tokenDecimals
      managerAddress
      timestamp: currentDayBucket
      lockedSupply
      dailyLockedAmount: lockedTodayBucket
      dailyUnlockedAmount: unlockedTodayBucket
    }
  }
`;

export const STABLES_CUSTODY_DAILY_SNAPSHOTS = `
  query StablesCustodyDailySnapshots(
    $chainIds: [Int!]!
    $limit: Int!
    $beforeTimestamp: numeric!
  ) {
    StableTokenCustodyDailySnapshot(
      where: {
        chainId: { _in: $chainIds }
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
      managerAddress
      timestamp
      lockedSupply
      dailyLockedAmount
      dailyUnlockedAmount
    }
  }
`;

export const STABLES_LATEST_CUSTODY_PER_TOKEN = `
  query StablesLatestCustodyPerToken($chainIds: [Int!]!) {
    StableTokenCustodyDailySnapshot(
      where: { chainId: { _in: $chainIds } }
      distinct_on: [chainId, tokenAddress]
      order_by: [{ chainId: asc }, { tokenAddress: asc }, { timestamp: desc }]
    ) {
      id
      chainId
      tokenAddress
      tokenSymbol
      source
      tokenDecimals
      managerAddress
      timestamp
      lockedSupply
      dailyLockedAmount
      dailyUnlockedAmount
    }
  }
`;

// Per-tx supply changes for the /stables changes table + ranked table. The
// V3 streams (TroveOperationEvent / RedemptionEvent / LiquidationEvent) merge
// in on the client side — those carry source-specific fields that don't
// normalize cleanly into StableSupplyChangeEvent.
export const STABLES_CHANGES = `
  query StablesChanges(
    $chainIds: [Int!]!
    $sinceTimestamp: numeric!
    $limit: Int!
    $offset: Int!
  ) {
    StableSupplyChangeEvent(
      where: {
        chainId: { _in: $chainIds }
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
