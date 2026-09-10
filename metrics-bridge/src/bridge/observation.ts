import { GraphQLClient, gql } from "graphql-request";
import { z } from "zod";
import { HASURA_URL } from "../config.js";
import {
  BRIDGE_MAX_PAGES,
  BRIDGE_MAX_ROWS,
  BRIDGE_OBSERVATION_TIMEOUT_MS,
  BRIDGE_PAGE_SIZE,
} from "./config.js";

const rowSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  sourceChainId: z.number().int().nullable(),
  destChainId: z.number().int().nullable(),
  tokenAddress: z.string().nullable(),
  sentTimestamp: z.string().nullable(),
  firstSeenAt: z.string().nullable(),
  lastUpdatedAt: z.string().nullable(),
  lastAttestedTimestamp: z.string().nullable(),
});
export type BridgeRow = z.infer<typeof rowSchema>;
const responseSchema = z.object({ BridgeTransfer: z.array(rowSchema) });

// Unknown endpoints might involve Polygon. Keep them visible in bounded unknown
// buckets. Known routes with neither endpoint Polygon are outside this domain.
export const BRIDGE_TRANSFERS_QUERY = gql`
  query BridgeTransferObservation($after: String!, $limit: Int!) {
    BridgeTransfer(
      limit: $limit
      order_by: { id: asc }
      where: {
        id: { _gt: $after }
        status: { _nin: ["DELIVERED", "CANCELLED", "FAILED"] }
        _or: [
          { sourceChainId: { _eq: 137 } }
          { destChainId: { _eq: 137 } }
          { sourceChainId: { _is_null: true } }
          { destChainId: { _is_null: true } }
        ]
      }
    ) {
      id
      status
      sourceChainId
      destChainId
      tokenAddress
      sentTimestamp
      firstSeenAt
      lastUpdatedAt
      lastAttestedTimestamp
    }
  }
`;
export type FetchBridgePage = (
  after: string,
  limit: number,
  signal: AbortSignal,
) => Promise<unknown>;
const client = new GraphQLClient(HASURA_URL);
const fetchPage: FetchBridgePage = (after, limit, signal) =>
  client.request({
    document: BRIDGE_TRANSFERS_QUERY,
    variables: { after, limit },
    signal,
  });

/** Keyset traversal is bounded, not a transaction: rows can progress between pages. */
export async function observeBridgeTransfers(
  options: {
    fetchPage?: FetchBridgePage;
    pageSize?: number;
    maxPages?: number;
    maxRows?: number;
    timeoutMs?: number;
  } = {},
): Promise<BridgeRow[]> {
  const pageSize = options.pageSize ?? BRIDGE_PAGE_SIZE;
  const maxPages = options.maxPages ?? BRIDGE_MAX_PAGES;
  const maxRows = options.maxRows ?? BRIDGE_MAX_ROWS;
  const timeoutMs = options.timeoutMs ?? BRIDGE_OBSERVATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Bridge observation timeout"));
    }, timeoutMs);
  });
  const collect = async () => {
    const rows = new Map<string, BridgeRow>();
    let after = "";
    let readRows = 0;
    for (let page = 0; page < maxPages; page++) {
      controller.signal.throwIfAborted();
      const response = responseSchema.parse(
        await (options.fetchPage ?? fetchPage)(
          after,
          pageSize,
          controller.signal,
        ),
      );
      const batch = response.BridgeTransfer;
      if (batch.length > pageSize)
        throw new Error("Bridge page exceeds requested limit");
      readRows += batch.length;
      if (readRows > maxRows) throw new Error("Bridge row budget exhausted");
      for (const row of batch) rows.set(row.id, row);
      if (batch.length < pageSize) return [...rows.values()];
      // Use server ordering: PostgreSQL collation is not JavaScript lexical order.
      const next = batch.at(-1)!.id;
      if (next === after) throw new Error("Bridge pagination did not advance");
      after = next;
    }
    throw new Error("Bridge page budget exhausted");
  };
  try {
    return await Promise.race([collect(), timedOut]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
