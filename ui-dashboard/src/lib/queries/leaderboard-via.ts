/**
 * Per-(trader, tx.to, day) route-attribution query for the v2 leaderboard Via
 * column. BrokerTraderRouterDayMarker carries the raw `tx.to` plus the cached
 * `aggregator` classification, so the dashboard can render clickable router
 * addresses for traders the bucketed view today labels `unknown` or wraps
 * under a generic name, while still collapsing cluster traders into a single
 * pill via the cached aggregator field. Filtered server-side by `caller _in`
 * + `timestamp _gte cutoff`; the `caller` and `timestamp` @index entries on
 * the entity keep this cheap.
 */
export const BROKER_TRADER_ROUTER_DAY_MARKERS = /* GraphQL */ `
  query BrokerTraderRouterDayMarkers(
    $callers: [String!]!
    $afterTimestamp: numeric!
    $limit: Int!
  ) {
    BrokerTraderRouterDayMarker(
      where: { caller: { _in: $callers }, timestamp: { _gte: $afterTimestamp } }
      order_by: [{ timestamp: desc }, { id: asc }]
      limit: $limit
    ) {
      id
      chainId
      caller
      txTo
      aggregator
      timestamp
    }
  }
`;
