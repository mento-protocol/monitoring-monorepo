// Chain-wide protocol-fee transfer queries. The barrel re-export lives in
// `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

/**
 * Fetch all protocol fee transfers for client-side USD aggregation.
 *
 * Capped at 10 000 rows as a safety net. Fee transfers are infrequent (the
 * yield split address receives fees only on swap activity, typically
 * hundreds/year), so this limit won't clip real data for a long time.
 *
 * Future: move USD conversion into a Hasura computed field or materialised
 * view so the browser only receives two numbers instead of N rows.
 */
export const PROTOCOL_FEE_TRANSFERS_ALL = `
  query ProtocolFeeTransfersAll($chainId: Int!) {
    ProtocolFeeTransfer(
      where: { chainId: { _eq: $chainId } }
      limit: 10000
      order_by: { blockTimestamp: desc }
    ) {
      chainId
      tokenSymbol
      tokenDecimals
      amount
      blockTimestamp
    }
  }
`;
