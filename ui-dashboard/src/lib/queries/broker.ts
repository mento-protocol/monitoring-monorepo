// Broker rollup queries. Re-exported from `../queries.ts` so existing
// `from "@/lib/queries"` imports stay stable.

// Daily rollup of legacy v2 (Broker -> BiPoolManager) volume on a chain.
// Filters out router-driven Broker.Swap events (the sibling-of-VirtualPool
// case where the v3 Router transitively invokes the Broker — counted as v3
// already via VirtualPool.Swap). chainId is filtered server-side because only
// Celo has a Broker today; Monad returns 0 rows.
//
// `id` is selected so the paginated fetcher can dedup on the canonical key
// (offset pagination over an append-only table is not stable under concurrent
// inserts). The schema id is `{chainId}-{provider}-{router|direct}-{day}`,
// which uniquely identifies a row across providers — required because two
// providers can share `(timestamp, volumeUsdWei, swapCount)`.
export const BROKER_DAILY_SNAPSHOTS_ALL = `
  query BrokerDailySnapshotsAll($chainId: Int!, $limit: Int!, $offset: Int!) {
    BrokerDailySnapshot(
      where: {
        chainId: { _eq: $chainId }
        routedViaV3Router: { _eq: false }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      timestamp
      volumeUsdWei
      swapCount
    }
  }
`;

// Current UTC-day volume for the v2 exchange backing a VirtualPool. This reads
// the bounded per-exchange rollup, not BrokerSwapEvent, so active exchanges do
// not hit Hasura's 1000-row per-query cap. The row includes all Broker.Swap
// paths for the exchangeId: direct v2, Router -> VirtualPool sibling rows, and
// aggregator -> VirtualPool -> Broker.
export const BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H = `
  query BrokerExchangeDailySnapshots24h(
    $chainId: Int!
    $exchangeId: String!
    $since: numeric!
  ) {
    BrokerExchangeDailySnapshot(
      where: {
        chainId: { _eq: $chainId }
        exchangeId: { _eq: $exchangeId }
        timestamp: { _gte: $since }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: 2
    ) {
      id
      timestamp
      volumeUsdWei
      swapCount
    }
  }
`;
