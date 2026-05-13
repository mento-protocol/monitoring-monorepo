/**
 * Narrow route-attribution query for the v2 leaderboard's Via column.
 *
 * BrokerAggregatorTraderDayMarker only stores its composite id today:
 * "{chainId}-{aggregator}-{caller}-{day}". The dashboard builds exact ids for
 * the visible top-trader rows and known route buckets, then parses the returned
 * ids client-side. Exact `_in` lookups avoid the slow regex scan that made the
 * Via column visibly lag behind the rest of the v2 table.
 */
export const BROKER_AGGREGATOR_TRADER_DAY_MARKERS_BY_ID = /* GraphQL */ `
  query BrokerAggregatorTraderDayMarkersById($ids: [String!]!, $limit: Int!) {
    BrokerAggregatorTraderDayMarker(
      where: { id: { _in: $ids } }
      order_by: { id: asc }
      limit: $limit
    ) {
      id
    }
  }
`;
