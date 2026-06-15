/**
 * Server-side discovery of unique addresses interacting with Mento via the
 * indexer. Used by the Arkham enrichment cron (label as much as possible)
 * and the MiniPay tagging cron (intersect against the attestation set).
 *
 * Hasura caps at 1000 rows per query — we use `distinct_on` + offset
 * pagination per (entity, field, chainId-column) tuple to walk past the cap.
 *
 * Chain selection is the caller's responsibility — each consumer has its
 * own provider-specific reason for the chain it queries (Arkham doesn't
 * index Monad; MiniPay's `FederatedAttestations` issuer is Celo-only).
 */

import { GraphQLClient } from "graphql-request";
import * as Sentry from "@sentry/nextjs";
import { isValidAddress } from "@/lib/validators";
import {
  buildDistinctQuery,
  DISCOVERY_TARGETS,
  type DiscoveryEntity,
} from "@/lib/mento-address-discovery-targets";

const PAGE_SIZE = 1000;
const HARD_PAGE_CAP = 50; // 50_000 rows per entity — sentinel against runaway loops
// Per-request timeout for the Hasura `distinct_on` calls. A hung query would
// otherwise block the cron route up to its 800s `maxDuration` cap with no
// progress signal. Mirrors `api/hasura/[networkId]/route.ts`.
const HASURA_REQUEST_TIMEOUT_MS = 10_000;

type DistinctRow = { address: string };
type DistinctQueryShape = Record<string, DistinctRow[]>;

async function fetchDistinctAddresses(
  client: GraphQLClient,
  target: DiscoveryEntity,
  chainId: number,
): Promise<string[]> {
  const { table, field } = target;
  const all = new Set<string>();
  let page = 0;
  const query = buildDistinctQuery(target);

  // Sequential pagination — early-exit on short-page; can't parallelize
  // without an upfront count.
  for (; page < HARD_PAGE_CAP; page += 1) {
    const offset = page * PAGE_SIZE;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const data = await client.request<DistinctQueryShape>({
      document: query,
      variables: { chainId, limit: PAGE_SIZE, offset },
      signal: AbortSignal.timeout(HASURA_REQUEST_TIMEOUT_MS),
    });
    const rows = data.rows ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const lower = r.address?.toLowerCase();
      if (lower && isValidAddress(lower)) all.add(lower);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  if (page === HARD_PAGE_CAP) {
    Sentry.captureMessage(
      `[mento-address-discovery] HARD_PAGE_CAP hit on ${table}.${field}`,
      { tags: { table, field }, level: "warning" },
    );
  }

  return Array.from(all);
}

type DiscoveryResult = {
  addresses: string[];
  perEntity: Array<{ table: string; field: string; count: number }>;
};

export async function discoverMentoAddresses(
  hasuraUrl: string,
  chainId: number,
): Promise<DiscoveryResult> {
  const client = new GraphQLClient(hasuraUrl);

  // (entity, field) pairs are independent — fan out concurrently. Pagination
  // *within* one pair stays sequential (offset depends on the previous page).
  const found = await Promise.all(
    DISCOVERY_TARGETS.map((target) =>
      fetchDistinctAddresses(client, target, chainId),
    ),
  );

  const all = new Set<string>();
  const perEntity: DiscoveryResult["perEntity"] = DISCOVERY_TARGETS.map(
    ({ table, field }, i) => {
      for (const a of found[i]!) all.add(a);
      return { table, field, count: found[i]!.length };
    },
  );

  return {
    addresses: Array.from(all).sort(),
    perEntity,
  };
}
