/**
 * GraphQL queries for the /bridge-flows page.
 *
 * Generic queries read only `Bridge*` entities and work unchanged when a
 * second provider (LayerZero, Axelar, …) is added. The single Wormhole-
 * specific query is loaded conditionally on the drill-down.
 */

// Recent transfers — paginated, newest first.
//
// Filter + sort on firstSeenAt (non-null) rather than sentTimestamp (nullable).
// Under unordered_multichain_mode, a destination-first TransferRedeemed can
// seed a BridgeTransfer row with sentTimestamp=null before the source events
// arrive — Hasura's _gte on a null column returns UNKNOWN and drops the row,
// so a filter on sentTimestamp would hide freshly-delivered transfers during
// the race window (and permanently hide any transfer whose source chain is
// not in the indexer's networks: list).
export const BRIDGE_TRANSFERS_WINDOW = /* GraphQL */ `
  query BridgeTransfersWindow($limit: Int!, $offset: Int!, $after: numeric!) {
    BridgeTransfer(
      where: { firstSeenAt: { _gte: $after } }
      order_by: { firstSeenAt: desc, id: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      provider
      providerMessageId
      status
      tokenSymbol
      tokenAddress
      tokenDecimals
      sourceChainId
      destChainId
      sender
      recipient
      amount
      sentTimestamp
      sentTxHash
      deliveredTimestamp
      deliveredTxHash
      attestationCount
      usdValueAtSend
      firstSeenAt
      lastUpdatedAt
    }
  }
`;

// Pending transfers: anything not yet delivered (and not terminally
// cancelled/failed). Includes:
//   PENDING         — destination-first race; digest known, source not yet
//                     indexed or not yet fired
//   SENT            — source TransferSent seen, awaiting guardian attestation
//   ATTESTED        — attested on destination, awaiting redeem
//   QUEUED_INBOUND  — attested but held by destination rate-limit window
// Excludes DELIVERED, CANCELLED, FAILED (terminal). No aggregate support on
// hosted Hasura, so paginate IDs + count client-side. Capped at 1000 (render
// as "1,000+" if we hit that — real bridge incident signal).
export const BRIDGE_PENDING_IDS = /* GraphQL */ `
  query BridgePendingIds {
    BridgeTransfer(
      where: {
        status: { _in: ["PENDING", "SENT", "ATTESTED", "QUEUED_INBOUND"] }
      }
      order_by: { firstSeenAt: desc, id: asc }
      limit: 1000
    ) {
      id
    }
  }
`;

// Daily aggregates for KPI tiles + the volume-over-time chart. Deterministic
// `date desc, id asc` ordering means that if the 1000-row cap is ever hit
// the missing rows are the oldest days, not an arbitrary slice — charts stay
// accurate for recent history and the page flags "partial data" for older.
export const BRIDGE_DAILY_SNAPSHOT = /* GraphQL */ `
  query BridgeDailySnapshot($afterDate: numeric!) {
    BridgeDailySnapshot(
      where: { date: { _gte: $afterDate } }
      order_by: { date: desc, id: asc }
      limit: 1000
    ) {
      id
      date
      provider
      tokenSymbol
      sourceChainId
      destChainId
      sentCount
      deliveredCount
      cancelledCount
      sentVolume
      deliveredVolume
      sentUsdValue
      updatedAt
    }
  }
`;

// Top bridgers — ranked by all-time sent count (USD will come via oracle rates client-side).
export const BRIDGE_TOP_BRIDGERS = /* GraphQL */ `
  query BridgeTopBridgers($limit: Int!) {
    BridgeBridger(order_by: { totalSentCount: desc }, limit: $limit) {
      id
      sender
      totalSentCount
      totalSentUsd
      sourceChainsUsed
      tokensUsed
      providersUsed
      firstSeenAt
      lastSeenAt
    }
  }
`;
