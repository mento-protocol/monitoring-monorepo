/**
 * Server-side discovery of unique addresses interacting with Mento on Celo.
 *
 * Pulls every distinct address from swaps, liquidity events, rebalances, LP
 * positions, OLS rebalancers, and bridge transfers — the union of these is
 * the candidate set for Arkham enrichment.
 *
 * Hasura caps at 1000 rows per query. For each entity we use `distinct_on`
 * to compress before fetching, then offset-paginate when an entity exceeds
 * the cap. The result is materialised into a single deduplicated Set so the
 * caller can diff against existing labels and call Arkham only on the
 * difference.
 */

import { GraphQLClient } from "graphql-request";

// Arkham only supports Celo, not Monad — tag every consumer with this so the
// chain-id assumption is greppable.
export const ARKHAM_SUPPORTED_CHAIN_IDS = new Set<number>([42220]);

const PAGE_SIZE = 1000;
const HARD_PAGE_CAP = 50; // 50_000 rows per entity — sentinel against runaway loops

type DistinctRow = { address: string };

type DistinctQueryShape = Record<string, DistinctRow[]>;

type EntityDef = {
  /** Hasura table name. */
  table: string;
  /** Columns on the table that hold an address. */
  fields: readonly string[];
};

const MENTO_ENTITIES: readonly EntityDef[] = [
  { table: "SwapEvent", fields: ["sender", "recipient"] },
  { table: "LiquidityEvent", fields: ["sender", "recipient"] },
  { table: "RebalanceEvent", fields: ["sender", "caller"] },
  { table: "LiquidityPosition", fields: ["address"] },
  { table: "OlsLiquidityEvent", fields: ["caller"] },
  { table: "BridgeTransfer", fields: ["sender", "recipient"] },
] as const;

/**
 * Page distinct values for one (table, field) pair on one chain.
 *
 * Hasura's `distinct_on` requires the field to also appear in `order_by`.
 * Pairing with `offset` lets us walk past the 1000-row cap. Bails after
 * `HARD_PAGE_CAP` pages to keep a misconfigured query from looping forever.
 */
async function fetchDistinctAddresses(
  client: GraphQLClient,
  table: string,
  field: string,
  chainId: number,
): Promise<string[]> {
  const all = new Set<string>();

  for (let page = 0; page < HARD_PAGE_CAP; page += 1) {
    const offset = page * PAGE_SIZE;
    const query = `
      query Distinct_${table}_${field}($chainId: Int!, $limit: Int!, $offset: Int!) {
        rows: ${table}(
          where: { chainId: { _eq: $chainId } }
          distinct_on: [${field}]
          order_by: { ${field}: asc }
          limit: $limit
          offset: $offset
        ) {
          address: ${field}
        }
      }
    `;
    const data = await client.request<DistinctQueryShape>(query, {
      chainId,
      limit: PAGE_SIZE,
      offset,
    });
    const rows = data.rows ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.address) all.add(r.address.toLowerCase());
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return Array.from(all);
}

export type DiscoveryResult = {
  /** All discovered addresses (lowercased, deduped). */
  addresses: string[];
  /** Per-entity counts for observability. */
  perEntity: Array<{ table: string; field: string; count: number }>;
};

/**
 * Discover every unique address that has ever interacted with Mento on the
 * given chain. Caller is responsible for filtering against existing labels
 * before sending to Arkham.
 */
export async function discoverMentoAddresses(
  hasuraUrl: string,
  chainId: number,
  fetchImpl?: typeof fetch,
): Promise<DiscoveryResult> {
  if (!ARKHAM_SUPPORTED_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `chainId ${chainId} is not supported by Arkham (only Celo / 42220 today)`,
    );
  }

  // graphql-request doesn't expose a plain `fetch` injection point on every
  // version — pass through `fetch` if provided, otherwise use the default.
  const client = new GraphQLClient(
    hasuraUrl,
    fetchImpl ? { fetch: fetchImpl } : undefined,
  );

  const all = new Set<string>();
  const perEntity: DiscoveryResult["perEntity"] = [];

  for (const entity of MENTO_ENTITIES) {
    for (const field of entity.fields) {
      const found = await fetchDistinctAddresses(
        client,
        entity.table,
        field,
        chainId,
      );
      perEntity.push({ table: entity.table, field, count: found.length });
      for (const a of found) all.add(a);
    }
  }

  return {
    addresses: Array.from(all).sort(),
    perEntity,
  };
}
