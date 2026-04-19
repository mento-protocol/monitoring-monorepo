/**
 * GraphQL queries for the /bridge-flows page.
 *
 * Generic queries read only `Bridge*` entities and work unchanged when a
 * second provider (LayerZero, Axelar, …) is added. The single Wormhole-
 * specific query is loaded conditionally on the drill-down.
 */

// Recent transfers — paginated, newest first.
export const BRIDGE_TRANSFERS_WINDOW = /* GraphQL */ `
  query BridgeTransfersWindow($limit: Int!, $offset: Int!, $after: numeric!) {
    BridgeTransfer(
      where: { sentTimestamp: { _gte: $after } }
      order_by: { sentTimestamp: desc, id: asc }
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
      firstSeenAt
      lastUpdatedAt
    }
  }
`;

export const BRIDGE_TRANSFER_COUNT = /* GraphQL */ `
  query BridgeTransferCount($after: numeric!) {
    BridgeTransfer_aggregate(where: { sentTimestamp: { _gte: $after } }) {
      aggregate {
        count
      }
    }
  }
`;

// Drill-down: full BridgeTransfer + Wormhole detail + recent attestations.
export const BRIDGE_TRANSFER_BY_ID = /* GraphQL */ `
  query BridgeTransferById($id: String!) {
    BridgeTransfer(where: { id: { _eq: $id } }) {
      id
      provider
      providerMessageId
      status
      tokenSymbol
      tokenAddress
      tokenDecimals
      sourceChainId
      sourceContract
      destChainId
      destContract
      sender
      recipient
      amount
      sentBlock
      sentTimestamp
      sentTxHash
      attestationCount
      firstAttestedTimestamp
      lastAttestedTimestamp
      deliveredBlock
      deliveredTimestamp
      deliveredTxHash
      cancelledTimestamp
      failedReason
      usdValueAtSend
      firstSeenAt
      lastUpdatedAt
    }
    BridgeAttestation(
      where: { transferId: { _eq: $id } }
      order_by: { blockTimestamp: asc }
    ) {
      id
      provider
      attester
      attesterIndex
      chainId
      blockTimestamp
      txHash
    }
  }
`;

export const WORMHOLE_TRANSFER_DETAIL_BY_ID = /* GraphQL */ `
  query WormholeTransferDetailById($id: String!) {
    WormholeTransferDetail(where: { id: { _eq: $id } }) {
      id
      digest
      msgSequence
      sourceWormholeChainId
      destWormholeChainId
      refundAddress
      fee
      outboundQueuedSequence
      inboundQueuedTimestamp
      rateLimitedCurrentCapacity
    }
  }
`;

// Daily aggregates for KPI tiles and the volume-over-time chart.
export const BRIDGE_DAILY_SNAPSHOT = /* GraphQL */ `
  query BridgeDailySnapshot($afterDate: numeric!) {
    BridgeDailySnapshot(
      where: { date: { _gte: $afterDate } }
      order_by: { date: asc }
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
