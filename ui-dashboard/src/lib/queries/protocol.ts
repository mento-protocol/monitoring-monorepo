// Chain-wide protocol-fee transfer queries. The barrel re-export lives in
// `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

/**
 * Fetch all protocol fee transfers for client-side USD aggregation.
 *
 * Nominally capped at 10 000 rows as a safety net. Fee transfers are
 * infrequent (the yield split address receives fees only on swap activity,
 * typically hundreds/year), so this limit won't clip real data for a long
 * time.
 *
 * **Caveat:** hosted Hasura silently caps every UI query at 1 000 rows
 * regardless of the literal limit (see `AGENTS.md` §"Recurring patterns").
 * Once any chain crosses 1 000 lifetime fee-transfer rows, the revenue
 * tiles will silently undercount. Tracked for follow-up: switch to a
 * pre-rolled snapshot entity or paginate with `fetchAllSnapshotPages`.
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
      from
    }
  }
`;
