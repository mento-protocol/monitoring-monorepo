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

import { GraphQLClient } from "@/lib/graphql-fetch";
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

/** One target's walk: what it collected, and whether a page request failed. */
type TargetWalk = { addresses: string[]; failed: boolean };

async function fetchDistinctAddresses(
  client: GraphQLClient,
  target: DiscoveryEntity,
  chainId: number,
): Promise<TargetWalk> {
  const { table, field } = target;
  const all = new Set<string>();
  let failed = false;
  let page = 0;
  const query = buildDistinctQuery(target);

  // Sequential pagination — early-exit on short-page; can't parallelize
  // without an upfront count.
  for (; page < HARD_PAGE_CAP; page += 1) {
    const offset = page * PAGE_SIZE;
    let data: DistinctQueryShape;
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      data = await client.request<DistinctQueryShape>({
        document: query,
        variables: { chainId, limit: PAGE_SIZE, offset },
        signal: AbortSignal.timeout(HASURA_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Fail open per target: this runs fanned out across several targets via
      // Promise.all in discoverMentoAddresses, so an unguarded throw here
      // (e.g. one page timing out) would reject the whole discovery run and
      // fail the cron check-in even though the other targets succeeded.
      // Keep whatever this target already collected instead, and report the
      // failure so discoverMentoAddresses can still fail an endpoint-wide
      // fault rather than reporting an empty run as a healthy one.
      Sentry.captureException(err, {
        tags: {
          table,
          field,
          source: "hasura",
          // Separate the two shapes on-call has to tell apart: a target that
          // died on its first page contributed nothing at all.
          degraded: page > 0 ? "partial-pages" : "no-pages",
        },
        extra: { page, addressesCollected: all.size },
      });
      failed = true;
      break;
    }
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

  return { addresses: Array.from(all), failed };
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
      const addresses = found[i]!.addresses;
      for (const a of addresses) all.add(a);
      return { table, field, count: addresses.length };
    },
  );

  // Any address the walk did collect is worth returning, however many targets
  // degraded getting it — the per-target Sentry reports carry that detail.
  // An empty result is the case that needs care: it is a legitimate answer
  // only when nothing failed. Reached with failures in it — an endpoint-wide
  // fault (auth, schema, network) being the usual cause — it is
  // indistinguishable from "nothing to discover", so returning it would give
  // the cron a healthy check-in for a run that read no data at all.
  const failedTargets = found.filter((walk) => walk.failed).length;
  if (all.size === 0 && failedTargets > 0) {
    throw new Error(
      `[mento-address-discovery] discovered nothing; ${failedTargets}/${found.length} targets failed`,
    );
  }

  return {
    addresses: Array.from(all).sort(),
    perEntity,
  };
}
