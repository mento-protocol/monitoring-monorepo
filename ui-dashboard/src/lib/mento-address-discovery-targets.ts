// Discovery targets + query builder for server-side unique-address discovery.
//
// Extracted into a zero-dependency module (no graphql-request / Sentry / React)
// so the GraphQL contract test can validate the dynamically-built `Distinct_*`
// queries against the indexer schema without dragging in the runtime deps of
// `mento-address-discovery.ts`. The runtime and the test share ONE builder, so
// the test validates the real query string instead of a drift-prone copy.

export type DiscoveryEntity = {
  table: string;
  field: string;
  /**
   * Column the chainId filter applies to. Most tables use `chainId`;
   * `BridgeTransfer` carries `sourceChainId` and `destChainId` separately
   * (no plain `chainId` column — see `indexer-envio/schema.graphql`).
   */
  chainIdColumn: string;
};

// Per-entity discovery targets. BridgeTransfer.sender filters on
// sourceChainId (outbound from Celo); .recipient on destChainId
// (inbound to Celo). Other entities use the canonical `chainId`.
export const DISCOVERY_TARGETS: readonly DiscoveryEntity[] = [
  { table: "SwapEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "SwapEvent", field: "recipient", chainIdColumn: "chainId" },
  // `caller` (tx.from) and `txTo` (tx.to) capture the EOA that signed the
  // swap and the entry-point contract — needed for MiniPay tagging since
  // routed v3 swaps surface the broker/router as `sender`, not the user.
  { table: "SwapEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "SwapEvent", field: "txTo", chainIdColumn: "chainId" },
  { table: "LiquidityEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "LiquidityEvent", field: "recipient", chainIdColumn: "chainId" },
  { table: "RebalanceEvent", field: "sender", chainIdColumn: "chainId" },
  { table: "RebalanceEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "LiquidityPosition", field: "address", chainIdColumn: "chainId" },
  { table: "OlsLiquidityEvent", field: "caller", chainIdColumn: "chainId" },
  { table: "BridgeTransfer", field: "sender", chainIdColumn: "sourceChainId" },
  { table: "BridgeTransfer", field: "recipient", chainIdColumn: "destChainId" },
] as const;

/**
 * Build the per-(entity, field) `distinct_on` pagination query. Takes
 * `$chainId`, `$limit`, `$offset` as variables. Kept as the single source of
 * truth for both the runtime cron path and the GraphQL contract test.
 */
export function buildDistinctQuery(target: DiscoveryEntity): string {
  const { table, field, chainIdColumn } = target;
  return `
      query Distinct_${table}_${field}($chainId: Int!, $limit: Int!, $offset: Int!) {
        rows: ${table}(
          where: { ${chainIdColumn}: { _eq: $chainId } }
          distinct_on: [${field}]
          order_by: { ${field}: asc }
          limit: $limit
          offset: $offset
        ) {
          address: ${field}
        }
      }
    `;
}
