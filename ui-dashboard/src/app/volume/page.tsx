import { Suspense } from "react";
import { getAuthSession } from "@/auth";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { fetchVolumeHeroForSSR } from "@/lib/volume-ssr";
import {
  activeChainIds,
  configuredProductionChainOptions,
  readChainFilter,
} from "@/lib/chain-filter";
import {
  readActorFilterFromParams,
  readRangeFromParams,
  readVenueFromParams,
} from "@/lib/volume-url-params";
import { VolumeClient } from "./page-client";

export const metadata = {
  title: "Volume | Mento Analytics",
  description:
    "Top traders on Mento by USD volume — sorted by 24h, 7d, 30d, or all-time, with per-pool flow breakdown.",
};

type PageSearchParams = Record<string, string | string[] | undefined>;

function toURLSearchParams(searchParams: PageSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}

// Same expression the client's `useHeroRollup` memoizes for the today-partial
// query variables. UTC-midnight edge: if the server computes day N and the
// client hydrates on day N+1, the view descriptors disagree and the client
// simply drops the fallback (loading path). If both land on day N but the day
// flips before the first poll, the today-partial fallback is one day off for
// ≤30s until SWR revalidates — self-healing, acceptable.
function currentUtcDayStartSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export default async function VolumePage({
  searchParams,
}: {
  searchParams?: Promise<PageSearchParams>;
} = {}) {
  const [session, resolvedSearchParams] = await Promise.all([
    getAuthSession(),
    searchParams,
  ]);
  const canUseVolumeFilters = !!session;
  const params = toURLSearchParams(resolvedSearchParams ?? {});
  const chainOptions = configuredProductionChainOptions();
  const chainIdIn = activeChainIds(
    readChainFilter(params, chainOptions),
    chainOptions,
  );

  // Derive the first-render view exactly as `useVolumeUrlState` will on the
  // client (shared parsing in lib/volume-url-params.ts). Logged-out visitors
  // are locked to the all-actors view — `?actors=` only applies when the
  // session grants the private volume filters.
  const venue = readVenueFromParams(params);
  const range = readRangeFromParams(params);
  const includeProtocolActors = canUseVolumeFilters
    ? readActorFilterFromParams(params) === "all"
    : true;

  // SSR-prefetch the unconditional hero queries (window snapshot + today
  // partial + firstDay slice) so the headline and KPI tiles paint populated
  // instead of "…" → numbers after the client waterfall (perf-plan S4).
  // Degrades to undefined on any primary-query failure; the client hooks then
  // load normally through their own loading states.
  const initialData = await fetchVolumeHeroForSSR(
    venue,
    range,
    includeProtocolActors,
    currentUtcDayStartSeconds(),
    chainIdIn,
  );

  return (
    <Suspense>
      <VolumeClient
        canUseVolumeFilters={canUseVolumeFilters}
        chainOptions={chainOptions}
        initialData={initialData}
      />
    </Suspense>
  );
}
