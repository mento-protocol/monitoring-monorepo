// Server-only cross-request cache for the SSR dashboard payload (perf-plan
// P7). `fetchAllNetworks` re-ran its full multi-network Hasura fan-out
// (1 + 13 queries per chain, several paginated) on every `/` and `/pools`
// request because the CSP-nonce middleware + layout cookie read force dynamic
// rendering — measured at 0.8–1.9s of server time squarely inside the LCP
// path. This module makes that fan-out a cache read for every request within
// the TTL.
//
// Not exported from the `@/lib/fetch-all-networks` barrel on purpose: that
// barrel is imported by client hooks, and this module pulls `next/cache`.
// Import it directly from Server Components only.

import { unstable_cache } from "next/cache";
import {
  fetchAllNetworks,
  isNetworkDataFullyHealthy,
} from "@/lib/network-fetcher/fetch";
import type { NetworkData, PoolLabel } from "@/lib/network-fetcher/types";

/**
 * `NetworkData` with every non-JSON field rewritten to a JSON round-trip-safe
 * shape. `unstable_cache` JSON-serializes cached values, which silently turns
 * `Map` into `{}` and `Set` into `{}` (lost oracle rates → blank TVL, lost
 * strategy badges) — the exact hazard the perf plan flags for the naive P7
 * fix. Every other `NetworkData` field is already plain JSON: Hasura BigInts
 * ride as decimal strings and error channels are flattened to `{ message }`
 * by `withSerializableErrors` inside `fetchAllNetworks`.
 */
type DehydratedNetworkData = Omit<
  NetworkData,
  "rates" | "poolLabels" | "olsPoolIds" | "cdpPoolIds" | "reservePoolIds"
> & {
  rates: [string, number][];
  poolLabels: [string, PoolLabel][];
  olsPoolIds: string[];
  cdpPoolIds: string[];
  reservePoolIds: string[];
};

export function dehydrateNetworkData(data: NetworkData): DehydratedNetworkData {
  return {
    ...data,
    rates: [...data.rates.entries()],
    poolLabels: [...data.poolLabels.entries()],
    olsPoolIds: [...data.olsPoolIds],
    cdpPoolIds: [...data.cdpPoolIds],
    reservePoolIds: [...data.reservePoolIds],
  };
}

export function rehydrateNetworkData(data: DehydratedNetworkData): NetworkData {
  return {
    ...data,
    rates: new Map(data.rates),
    poolLabels: new Map(data.poolLabels),
    olsPoolIds: new Set(data.olsPoolIds),
    cdpPoolIds: new Set(data.cdpPoolIds),
    reservePoolIds: new Set(data.reservePoolIds),
  };
}

/**
 * Drops the raw `feeSnapshots` rows (~330KB of the ~1.04MB Flight payload)
 * from the SSR payload. Nothing on `/` or `/pools` reads the raw rows — the
 * aggregated `fees` summary is computed server-side in `assembleNetworkData`
 * before this projection, `/revenue` uses its own slim `useProtocolFees` hook
 * with a separate SWR key, and `seedIncrementalRowCacheFromNetworkData`
 * intentionally never seeds fee history (it keeps full pagination so healed
 * rows are re-fetched). `feeSnapshotsError` / `feeSnapshotsTruncated` are
 * kept so `isNetworkDataFullyHealthy` and the `≈` truncation UX still see
 * the fetch outcome.
 */
function stripFeeSnapshotRows(
  data: DehydratedNetworkData,
): DehydratedNetworkData {
  return { ...data, feeSnapshots: [] };
}

/**
 * Carries the dehydrated payload of a degraded fetch out of `unstable_cache`
 * without caching it: thrown values propagate to the caller instead of being
 * written to the cache, so a partial/error payload is never pinned for the
 * TTL (it would otherwise trap every visitor on `N/A` tiles until expiry).
 */
class DegradedNetworkDataError extends Error {
  constructor(readonly payload: DehydratedNetworkData[]) {
    super("degraded network data payload — not cached");
    this.name = "DegradedNetworkDataError";
  }
}

async function fetchDehydratedInitialNetworkData(): Promise<
  DehydratedNetworkData[]
> {
  const data = await fetchAllNetworks();
  const dehydrated = data.map((networkData) =>
    stripFeeSnapshotRows(dehydrateNetworkData(networkData)),
  );
  // Empty = no configured networks (misconfigured env) — treat as degraded
  // rather than pinning an empty dashboard for the TTL.
  if (data.length === 0 || !data.every(isNetworkDataFullyHealthy)) {
    throw new DegradedNetworkDataError(dehydrated);
  }
  return dehydrated;
}

// 30s revalidate: half the pool-detail/OG 60s TTL because this payload IS the
// page (KPI tiles + pools table), not a preview. Client-side freshness after
// first paint is owned by the SWR poll (SNAPSHOT_REFRESH_MS); the healthy-
// payload mount-revalidation skip in `useAllNetworksData` means SSR staleness
// is user-visible until that first poll, so keep the TTL tight.
const cachedFetch = unstable_cache(
  fetchDehydratedInitialNetworkData,
  ["all-networks-ssr"],
  { revalidate: 30, tags: ["all-networks-ssr"] },
);

/**
 * Cached drop-in for `fetchAllNetworks()` in the `/` and `/pools` Server
 * Components. Healthy payloads are served from a 30s shared cache; degraded
 * payloads (any per-chain or per-slice error) bypass the cache entirely so
 * the next request retries upstream — mirroring the client hook, which
 * revalidates degraded fallbacks on mount. Raw `feeSnapshots` rows are
 * stripped (see `stripFeeSnapshotRows`); use `fetchAllNetworks` directly if a
 * future server consumer needs them.
 */
export async function fetchInitialNetworkData(): Promise<NetworkData[]> {
  try {
    return (await cachedFetch()).map(rehydrateNetworkData);
  } catch (err) {
    if (err instanceof DegradedNetworkDataError) {
      return err.payload.map(rehydrateNetworkData);
    }
    throw err;
  }
}
