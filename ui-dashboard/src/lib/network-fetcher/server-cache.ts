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
import { NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";

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

/** Cached wrapper shape: `fetchedAt` (Date.now() at fetch completion) rides
 *  along so `fetchInitialNetworkData` can age-gate stale cache hits. */
interface CachedNetworkPayload {
  fetchedAt: number;
  networks: DehydratedNetworkData[];
}

async function fetchDehydratedInitialNetworkData(): Promise<CachedNetworkPayload> {
  const data = await fetchAllNetworks();
  const dehydrated = data.map((networkData) =>
    stripFeeSnapshotRows(dehydrateNetworkData(networkData)),
  );
  // Empty = no configured networks (misconfigured env) — treat as degraded
  // rather than pinning an empty dashboard for the TTL.
  if (data.length === 0 || !data.every(isNetworkDataFullyHealthy)) {
    throw new DegradedNetworkDataError(dehydrated);
  }
  return { fetchedAt: Date.now(), networks: dehydrated };
}

// 30s revalidate — but NOT a staleness bound: on dynamic renders
// `unstable_cache` serves a stale entry immediately and revalidates in the
// background, and it swallows background-revalidation errors (including our
// `DegradedNetworkDataError`), keeping the stale entry served. So the first
// request after an idle gap gets an arbitrarily old payload, and once one
// healthy entry exists a degraded upstream never surfaces through this
// wrapper alone. The `fetchedAt` age gate in `fetchInitialNetworkData` is
// what bounds served staleness and re-opens the degraded-error channel.
// Vercel's Data Cache persists across deployments within an environment, and
// `unstable_cache` keys only on this wrapper's source + the explicit parts —
// not on `fetchAllNetworks`'s env-derived network set or the dehydrated
// payload shape. Salt the key with the deployment SHA (fresh entry per
// deploy — one fan-out per deploy is cheap insurance against a new build
// reading an old-shape payload) and the configured network ids (covers
// env-only config changes and local dev where no SHA exists).
const CACHE_KEY_PARTS = [
  "all-networks-ssr",
  process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  NETWORK_IDS.filter(isConfiguredNetworkId).join("|"),
];

const cachedFetch = unstable_cache(
  fetchDehydratedInitialNetworkDataCoalesced,
  CACHE_KEY_PARTS,
  { revalidate: 30, tags: ["all-networks-ssr"] },
);

// 3× the 30s TTL: under steady traffic the serve-stale-while-revalidate
// window keeps real staleness ≈ one TTL, so this bound only bites after idle
// gaps (first visitor after a quiet stretch) or sustained degradation —
// exactly the cases where a foreground refetch is worth the latency.
// Exported so tests derive their boundary fixtures from the real constant.
export const MAX_SERVED_STALENESS_MS = 90_000;

// Coalesce EVERY invocation of the upstream fan-out within this isolate:
// concurrent cold-miss fills, the background revalidation `unstable_cache`
// schedules on a stale hit, and the over-age foreground refetch in
// `fetchInitialNetworkData` all share one in-flight fan-out. Feeding this
// coalesced function to `unstable_cache` (rather than only wrapping the
// age-gate path) matters: on an over-age hit Next has ALREADY started its
// background revalidation of this same callback, so a separately-coalesced
// foreground copy would still pair with it and double the upstream work.
// Cross-instance duplication remains possible and is bounded by the number
// of warm instances.
let inFlightFanout: Promise<CachedNetworkPayload> | null = null;

function fetchDehydratedInitialNetworkDataCoalesced(): Promise<CachedNetworkPayload> {
  inFlightFanout ??= fetchDehydratedInitialNetworkData().finally(() => {
    inFlightFanout = null;
  });
  return inFlightFanout;
}

/**
 * Cached drop-in for `fetchAllNetworks()` in the `/` and `/pools` Server
 * Components. Healthy payloads are served from a shared `unstable_cache`
 * entry (30s TTL, ~90s worst-case served staleness); degraded payloads (any
 * per-chain or per-slice error) are thrown out of the cache callback so they
 * are never written to the cache. That bypass alone only covers cold misses —
 * on a stale hit `unstable_cache` swallows the revalidation error — so the
 * `fetchedAt` age gate below discards cache results older than
 * `MAX_SERVED_STALENESS_MS` and refetches in the foreground, giving idle-gap
 * visitors fresh data and letting a sustained outage surface as the fresh
 * degraded payload (error channels intact → the client hook's mount
 * revalidation fires) instead of a pinned last-healthy one. Raw
 * `feeSnapshots` rows are stripped (see `stripFeeSnapshotRows`); use
 * `fetchAllNetworks` directly if a future server consumer needs them.
 */
export async function fetchInitialNetworkData(): Promise<NetworkData[]> {
  try {
    const cached = await cachedFetch();
    const payload =
      Date.now() - cached.fetchedAt > MAX_SERVED_STALENESS_MS
        ? // Joins the background revalidation `unstable_cache` started for
          // this same stale hit (shared in-flight promise) instead of
          // launching a second fan-out.
          await fetchDehydratedInitialNetworkDataCoalesced()
        : cached;
    return payload.networks.map(rehydrateNetworkData);
  } catch (err) {
    if (err instanceof DegradedNetworkDataError) {
      return err.payload.map(rehydrateNetworkData);
    }
    throw err;
  }
}
