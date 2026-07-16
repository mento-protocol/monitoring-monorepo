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
import type {
  InitialNetworkData,
  NetworkData,
  PoolLabel,
} from "@/lib/network-fetcher/types";
import {
  INITIAL_SNAPSHOT_HISTORY_DAYS,
  SECONDS_PER_DAY,
} from "@/lib/network-fetcher/constants";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";

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

type DehydratedInitialNetworkData = Omit<
  DehydratedNetworkData,
  | "feeSnapshots"
  | "snapshots"
  | "snapshots7d"
  | "snapshots30d"
  | "uniqueLpAddresses"
  | "uniqueLpAddressesOmitted"
> & {
  feeSnapshots: [];
  snapshots: [];
  snapshots7d: [];
  snapshots30d: [];
  uniqueLpAddresses: null;
  uniqueLpAddressesOmitted: true;
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
 * Projects the full network response into the bounded homepage Server
 * Component payload (the `/pools` route applies one additional omission):
 *
 * - raw `feeSnapshots` rows are dropped because those routes only read the
 *   already-aggregated `fees` summary; `/revenue` has its own SWR key;
 * - the 1/7/30-day arrays are dropped because the client-safe daily-slice
 *   helper reconstructs them synchronously from the canonical daily rows;
 * - `snapshotsAllDaily` keeps the latest `INITIAL_SNAPSHOT_HISTORY_DAYS`
 *   UTC-day buckets plus one pre-window anchor per pool. The anchor lets the
 *   TVL chart forward-fill quiet pools from their last confirmed reserves;
 *   the bounded rows still cover every default chart/KPI window without
 *   letting the Flight payload grow forever.
 * - Broker history keeps one additional UTC-day boundary bucket beyond the
 *   pool window. The rolling 30-day chart starts at the prior midnight during
 *   UTC hour zero, so that bucket is required until the next hourly boundary.
 * - cumulative LP addresses are replaced by a payload-level exact cross-chain
 *   count before serialization. The raw addresses never enter the Data Cache
 *   or Flight payload.
 *
 * The routes use isolated client SWR keys so `/pools` can omit homepage-only
 * Broker history without overwriting the homepage seed. The cap fields are
 * the explicit handoff contract: the client may use bounded rows for recent
 * windows and as last-good data, but it must force a from-zero pagination
 * before presenting "All". Error/truncation outcome fields remain intact so
 * health and degraded UI semantics do not change.
 */
function projectPoolSnapshotHistory(
  rows: DehydratedNetworkData["snapshotsAllDaily"],
  cutoff: number,
): DehydratedNetworkData["snapshotsAllDaily"] {
  const recentRows: DehydratedNetworkData["snapshotsAllDaily"] = [];
  const anchorByPool = new Map<
    string,
    DehydratedNetworkData["snapshotsAllDaily"][number]
  >();
  for (const row of rows) {
    const timestamp = Number(row.timestamp);
    if (timestamp >= cutoff) {
      recentRows.push(row);
      continue;
    }
    const currentAnchor = anchorByPool.get(row.poolId);
    if (
      currentAnchor === undefined ||
      timestamp > Number(currentAnchor.timestamp)
    ) {
      anchorByPool.set(row.poolId, row);
    }
  }
  return [...recentRows, ...anchorByPool.values()];
}

function projectInitialNetworkData(
  data: DehydratedNetworkData,
): DehydratedInitialNetworkData {
  // Anchor the cap to the exact clock snapshot used to derive the server's
  // 1/7/30-day windows. Using fetch-completion time here creates a midnight
  // race: a fan-out that starts before 00:00 and finishes after it could drop
  // the oldest row still required by the already-computed 30-day window.
  const todayMidnightUtc =
    Math.floor(data.snapshotWindows.w24h.to / SECONDS_PER_DAY) *
    SECONDS_PER_DAY;
  const poolCutoff =
    todayMidnightUtc - (INITIAL_SNAPSHOT_HISTORY_DAYS - 1) * SECONDS_PER_DAY;
  const brokerCutoff =
    todayMidnightUtc - INITIAL_SNAPSHOT_HISTORY_DAYS * SECONDS_PER_DAY;
  const snapshotsAllDaily = projectPoolSnapshotHistory(
    data.snapshotsAllDaily,
    poolCutoff,
  );
  const brokerSnapshotsAllDaily = data.brokerSnapshotsAllDaily.filter(
    (snapshot) => Number(snapshot.timestamp) >= brokerCutoff,
  );
  return {
    ...data,
    feeSnapshots: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily,
    snapshotsAllDailyCapped:
      data.snapshotsAllDailyCapped ||
      snapshotsAllDaily.length < data.snapshotsAllDaily.length,
    brokerSnapshotsAllDaily,
    brokerSnapshotsAllDailyCapped:
      data.brokerSnapshotsAllDailyCapped === true ||
      brokerSnapshotsAllDaily.length < data.brokerSnapshotsAllDaily.length,
    uniqueLpAddresses: null,
    uniqueLpAddressesOmitted: true,
  };
}

function rehydrateInitialNetworkData(
  data: DehydratedInitialNetworkData,
  route: InitialNetworkDataRoute,
): InitialNetworkData {
  const rehydrated: InitialNetworkData = {
    ...rehydrateNetworkData(data),
    feeSnapshots: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    uniqueLpAddresses: null,
    uniqueLpAddressesOmitted: true,
  };
  if (route === "home") return rehydrated;

  // `/pools` consumes neither Broker volume history nor LP addresses. Keep the
  // same shared server cache entry, then remove the homepage-only bounded rows
  // at the final route projection so they never cross this route's Flight
  // boundary. The route's isolated SWR key prevents this intentionally slim
  // fallback from replacing the homepage seed.
  return {
    ...rehydrated,
    brokerSnapshotsAllDaily: [],
    brokerSnapshotsAllDailyCapped:
      rehydrated.brokerSnapshotsAllDaily.length > 0 ||
      rehydrated.brokerSnapshotsAllDailyCapped === true,
  };
}

/** Exact homepage LP KPI semantics, computed while the raw address sets are
 * still available. Successful chains are unioned case-insensitively; a total
 * network failure makes the protocol-wide result unknowable, while an LP-only
 * failure still preserves the lower-bound count from successful chains (the
 * retained per-network error/truncation flags drive the existing disclosure). */
function aggregateUniqueLpCount(data: readonly NetworkData[]): number | null {
  if (data.some((networkData) => networkData.error !== null)) return null;

  const addresses = new Set<string>();
  let hasSuccessfulResult = false;
  let hasLpError = false;
  for (const networkData of data) {
    if (networkData.lpError !== null) hasLpError = true;
    if (networkData.uniqueLpAddresses === null) continue;
    hasSuccessfulResult = true;
    for (const address of networkData.uniqueLpAddresses) {
      addresses.add(address.toLowerCase());
    }
  }
  return !hasSuccessfulResult && hasLpError ? null : addresses.size;
}

/**
 * Carries the dehydrated payload of a degraded fetch out of `unstable_cache`
 * without caching it: thrown values propagate to the caller instead of being
 * written to the cache, so a partial/error payload is never pinned for the
 * TTL (it would otherwise trap every visitor on `N/A` tiles until expiry).
 */
class DegradedNetworkDataError extends Error {
  declare readonly payload: CachedNetworkPayload;

  constructor(payload: CachedNetworkPayload) {
    super("degraded network data payload — not cached");
    this.name = "DegradedNetworkDataError";
    // Non-enumerable: `unstable_cache`'s swallowed-error path console.errors
    // the whole error object during background revalidation, and an
    // enumerable payload would dump the multi-hundred-KB dehydrated
    // dashboard into server logs on every stale revalidation while upstream
    // is degraded. The foreground catch still reads it by name.
    Object.defineProperty(this, "payload", {
      value: payload,
      enumerable: false,
    });
  }
}

/** Cached wrapper shape: `fetchedAt` (Date.now() at fetch completion) rides
 *  along so `fetchInitialNetworkData` can age-gate stale cache hits. */
interface CachedNetworkPayload {
  fetchedAt: number;
  networks: DehydratedInitialNetworkData[];
  /** Exact aggregate replacing the cumulative per-network LP address arrays. */
  uniqueLpCount: number | null;
}

async function fetchDehydratedInitialNetworkData(): Promise<CachedNetworkPayload> {
  const data = await fetchAllNetworks();
  // One completion timestamp records cache freshness. The history projection
  // itself uses each payload's shared window clock (see above).
  const fetchedAt = Date.now();
  const uniqueLpCount = aggregateUniqueLpCount(data);
  const dehydrated = data.map((networkData) =>
    projectInitialNetworkData(dehydrateNetworkData(networkData)),
  );
  // Empty = no configured networks (misconfigured env) — treat as degraded
  // rather than pinning an empty dashboard for the TTL.
  if (data.length === 0 || !data.every(isNetworkDataFullyHealthy)) {
    throw new DegradedNetworkDataError({
      fetchedAt,
      networks: dehydrated,
      uniqueLpCount,
    });
  }
  return { fetchedAt, networks: dehydrated, uniqueLpCount };
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
// payload shape. Salt the key with:
//  - the deployment id (unique per deployment, INCLUDING env-only redeploys
//    that keep the same git commit — an env change repointing a Hasura URL
//    only takes effect via a redeploy, so this fully covers endpoint
//    swaps; commit SHA is the fallback where the id isn't exposed), and
//  - the configured network ids + their Hasura endpoints (covers local dev,
//    where no deployment id exists but `.next/cache` persists across
//    restarts with different env).
// One fan-out per deploy is cheap insurance against a new deployment
// reading a payload fetched by old code or from an old endpoint.
const CACHE_KEY_PARTS = [
  // Explicit projection version also protects persistent local `.next/cache`
  // entries where no Vercel deployment id is available.
  "all-networks-ssr-v2",
  process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    "dev",
  NETWORK_IDS.flatMap((id) =>
    isConfiguredNetworkId(id) ? [`${id}=${NETWORKS[id].hasuraUrl}`] : [],
  ).join("|"),
];

const cachedFetch = unstable_cache(
  fetchDehydratedInitialNetworkDataCoalesced,
  CACHE_KEY_PARTS,
  { revalidate: 30, tags: ["all-networks-ssr"] },
);

// Aligned with SNAPSHOT_REFRESH_MS (the 5-min client poll cadence users
// already accept between refreshes). Production traffic is sparse — ~96
// homepage document requests/day, ~15-min average gaps — so a tight bound
// would force the common isolated visitor into a foreground fan-out; instead
// we serve up to 5-min-old data instantly and rely on the client-side
// freshness gate in `useAllNetworksData` (payloads older than
// SSR_FRESH_ENOUGH_MS revalidate immediately on mount), so stale numbers are
// on screen for the ~1-2s the refetch takes, not until the next poll.
// Exported so tests derive their boundary fixtures from the real constant.
export const MAX_SERVED_STALENESS_MS = 300_000;

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

/** SSR payload plus its fetch-completion timestamp. `fetchedAtMs` crosses to
 *  the client so `useAllNetworksData` can gate its mount-revalidation skip on
 *  actual payload freshness rather than trusting whatever the cache served. */
export type InitialNetworkDataRoute = "home" | "pools";

export type InitialNetworkDataPayload = {
  networks: InitialNetworkData[];
  fetchedAtMs: number;
  /** Present only for the homepage route; exact replacement for omitted raw
   * LP address arrays. `null` retains the existing unavailable semantics. */
  uniqueLpCount?: number | null | undefined;
};

/**
 * Cached drop-in for `fetchAllNetworks()` in the `/` and `/pools` Server
 * Components. Healthy payloads are served from a shared `unstable_cache`
 * entry (30s TTL, up to `MAX_SERVED_STALENESS_MS` of served staleness);
 * degraded payloads (any per-chain or per-slice error) are thrown out of the
 * cache callback so they are never written to the cache. That bypass alone
 * only covers cold misses — on a stale hit `unstable_cache` swallows the
 * revalidation error — so the `fetchedAt` age gate below discards cache
 * results older than `MAX_SERVED_STALENESS_MS` and refetches in the
 * foreground, giving long-idle-gap visitors fresh data and letting a
 * sustained outage surface as the fresh degraded payload (error channels
 * intact → the client hook's mount revalidation fires) instead of a pinned
 * last-healthy one. Within the staleness window, freshness is the CLIENT's
 * job: the returned `fetchedAtMs` drives the hook's freshness gate, which
 * revalidates on mount whenever the payload is older than its
 * fresh-enough bound — instant paint, live data ~1-2s later. Raw fee rows,
 * redundant window arrays, and history older than the bounded SSR window are
 * projected out (see `projectInitialNetworkData`); use `fetchAllNetworks`
 * directly if a future
 * server consumer needs either full dataset.
 */
export async function fetchInitialNetworkData(
  route: InitialNetworkDataRoute,
): Promise<InitialNetworkDataPayload> {
  try {
    const cached = await cachedFetch();
    const payload =
      Date.now() - cached.fetchedAt > MAX_SERVED_STALENESS_MS
        ? // Joins the background revalidation `unstable_cache` started for
          // this same stale hit (shared in-flight promise) instead of
          // launching a second fan-out.
          await fetchDehydratedInitialNetworkDataCoalesced()
        : cached;
    const result: InitialNetworkDataPayload = {
      networks: payload.networks.map((networkData) =>
        rehydrateInitialNetworkData(networkData, route),
      ),
      fetchedAtMs: payload.fetchedAt,
    };
    if (route === "home") result.uniqueLpCount = payload.uniqueLpCount;
    return result;
  } catch (err) {
    if (err instanceof DegradedNetworkDataError) {
      // Degraded payloads are fetched in-band (never cached), so they are
      // fresh as of this request.
      const result: InitialNetworkDataPayload = {
        networks: err.payload.networks.map((networkData) =>
          rehydrateInitialNetworkData(networkData, route),
        ),
        fetchedAtMs: err.payload.fetchedAt,
      };
      if (route === "home") result.uniqueLpCount = err.payload.uniqueLpCount;
      return result;
    }
    throw err;
  }
}
