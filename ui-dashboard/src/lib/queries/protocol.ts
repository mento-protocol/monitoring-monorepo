// Chain-wide protocol-fee transfer queries. The barrel re-export lives in
// `../queries.ts` so existing `from "@/lib/queries"` imports stay stable;
// consumers can also import directly from this module.

/**
 * Fetch all protocol fee transfers for client-side USD aggregation.
 *
 * Hosted Envio Hasura silently caps every UI query at 1 000 rows regardless
 * of the literal `limit` (see `AGENTS.md` §"Recurring patterns"). The literal
 * here matches that cap so `aggregateProtocolFees().isTruncated` flips at the
 * real ceiling — otherwise the lower-bound badge stays hidden until 10 000
 * rows that prod will never deliver. Once any chain crosses 1 000 lifetime
 * fee-transfer rows, the revenue tiles correctly mark themselves as a lower
 * bound. Follow-up: switch to a pre-rolled snapshot entity or paginate with
 * `fetchAllSnapshotPages`.
 */
export const PROTOCOL_FEE_TRANSFERS_ALL = `
  query ProtocolFeeTransfersAll($chainId: Int!) {
    ProtocolFeeTransfer(
      where: { chainId: { _eq: $chainId } }
      limit: 1000
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
