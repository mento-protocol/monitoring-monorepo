/**
 * Narrow route-attribution query for the v2 leaderboard's Via column.
 *
 * BrokerAggregatorTraderDayMarker only stores its composite id today:
 * "{chainId}-{aggregator}-{caller}-{day}". Query by a bounded regex for the
 * visible top-trader rows, then parse the id client-side.
 */
export const BROKER_AGGREGATOR_TRADER_DAY_MARKERS = /* GraphQL */ `
  query BrokerAggregatorTraderDayMarkers($idRegex: String!, $limit: Int!) {
    BrokerAggregatorTraderDayMarker(
      where: { id: { _regex: $idRegex } }
      order_by: { id: asc }
      limit: $limit
    ) {
      id
    }
  }
`;
