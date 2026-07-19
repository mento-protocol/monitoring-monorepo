// Pure URL-param parsing for the /volume page (range / actor filter / venue).
//
// Extracted from `app/volume/_lib/url-state.ts` (which is client-marked) so the
// `/volume` Server Component can derive the first-render view for SSR-prefetch
// with the exact same parsing + defaults the client hook uses — a silently
// diverging server-side re-implementation would attach `fallbackData` to the
// wrong SWR key. Zero runtime dependencies: safe on both sides of the
// server/client boundary (see docs/pr-checklists/recurring-review-patterns.md).

import type { VolumeRangeKey } from "@/lib/volume";

export type Venue = "v3" | "v2";
export type ActorFilter = "organic" | "all";

const VALID_RANGES = new Set<VolumeRangeKey>([
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
]);
export const DEFAULT_RANGE: VolumeRangeKey = "7d";
const VALID_VENUES = new Set<Venue>(["v3", "v2"]);
export const DEFAULT_ACTOR_FILTER: ActorFilter = "organic";

export function readRangeFromParams(params: URLSearchParams): VolumeRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as VolumeRangeKey)
    ? (raw as VolumeRangeKey)
    : DEFAULT_RANGE;
}

export function readActorFilterFromParams(
  params: URLSearchParams,
): ActorFilter {
  return params.get("actors") === "all" ? "all" : DEFAULT_ACTOR_FILTER;
}

export function readVenueFromParams(params: URLSearchParams): Venue {
  const raw = params.get("venue");
  return raw && VALID_VENUES.has(raw as Venue) ? (raw as Venue) : "v3";
}
