"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import { rangeCutoffSeconds, type VolumeRangeKey } from "@/lib/volume";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import {
  normalizeVolumeExclusionAddress,
  normalizeVolumeExclusionSource,
  type VolumeExclusionState,
} from "@/lib/volume-exclusions";

export type Venue = "v3" | "v2";
type ActorFilter = "organic" | "all";
type VolumeUrlSnapshot = {
  range: VolumeRangeKey;
  actorFilter: ActorFilter;
  exclusions: VolumeExclusionState;
  venue: Venue;
};
type VolumeUrlSetters = {
  setRange: Dispatch<SetStateAction<VolumeRangeKey>>;
  setActorFilter: Dispatch<SetStateAction<ActorFilter>>;
  setExclusions: Dispatch<SetStateAction<VolumeExclusionState>>;
  setVenue: Dispatch<SetStateAction<Venue>>;
};
type VolumeUrlActionInputs = VolumeUrlSetters &
  VolumeUrlSnapshot & {
    canUseVolumeFilters: boolean;
  };
type VolumeUrlStateOptions = {
  canUseVolumeFilters: boolean;
};
type VolumeUrlStateResult = {
  canUseVolumeFilters: boolean;
  range: VolumeRangeKey;
  actorFilter: ActorFilter;
  includeProtocolActors: boolean;
  exclusions: VolumeExclusionState;
  venue: Venue;
  cutoff: number;
  utcDayKey: number;
  updateRange: (next: VolumeRangeKey) => void;
  updateIncludeProtocolActors: (next: boolean) => void;
  updateExclusions: (next: VolumeExclusionState) => void;
  updateVenue: (next: Venue) => void;
};

const VALID_RANGES = new Set<VolumeRangeKey>([
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
]);
const DEFAULT_RANGE: VolumeRangeKey = "7d";
const VALID_VENUES = new Set<Venue>(["v3", "v2"]);
const DEFAULT_ACTOR_FILTER: ActorFilter = "organic";

function readRangeFromParams(params: URLSearchParams): VolumeRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as VolumeRangeKey)
    ? (raw as VolumeRangeKey)
    : DEFAULT_RANGE;
}

function readActorFilterFromParams(params: URLSearchParams): ActorFilter {
  return params.get("actors") === "all" ? "all" : DEFAULT_ACTOR_FILTER;
}

function readVenueFromParams(params: URLSearchParams): Venue {
  const raw = params.get("venue");
  return raw && VALID_VENUES.has(raw as Venue) ? (raw as Venue) : "v3";
}

function readExclusionsFromParams(
  params: URLSearchParams,
): VolumeExclusionState {
  return {
    addresses: readParamList(
      params,
      "exclude",
      normalizeVolumeExclusionAddress,
    ),
    sources: readParamList(
      params,
      "excludeSources",
      normalizeVolumeExclusionSource,
    ),
  };
}

function readParamList(
  params: URLSearchParams,
  key: string,
  normalize: (value: string) => string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of params.getAll(key)) {
    for (const token of value.split(",")) {
      const normalized = normalize(token);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
  }
  return out;
}

function writeParamList(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
) {
  params.delete(key);
  if (values.length > 0) params.set(key, values.join(","));
}

function writeVolumeUrl(
  { range, actorFilter, exclusions, venue }: VolumeUrlSnapshot,
  canUseVolumeFilters: boolean,
) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (range === DEFAULT_RANGE) params.delete("range");
  else params.set("range", range);
  if (!canUseVolumeFilters) {
    params.delete("actors");
  } else if (actorFilter === DEFAULT_ACTOR_FILTER) {
    params.delete("actors");
  } else {
    params.set("actors", actorFilter);
  }
  if (canUseVolumeFilters) {
    writeParamList(params, "exclude", exclusions.addresses);
    writeParamList(params, "excludeSources", exclusions.sources);
  } else {
    params.delete("exclude");
    params.delete("excludeSources");
  }
  if (venue === "v3") params.delete("venue");
  else params.set("venue", venue);
  replaceVolumeUrlSearch(params);
}

function replaceVolumeUrlSearch(params: URLSearchParams) {
  const qs = params.toString();
  const nextUrl =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

/**
 * URL-backed state for the volume page (range / actor filter / venue /
 * exploratory exclusions).
 *
 * Reads happen via `useSearchParams` on initial mount; writes go through
 * `window.history.replaceState` (NOT `router.replace`) — the App Router's
 * `router.replace` triggers an RSC payload refetch on the current segment
 * (`?_rsc=...`) every URL write, which adds ~700ms latency. See AGENTS.md
 * "URL state in client-only tables / filters" + PR #314 for the rule.
 *
 * Also owns the UTC-day rollover ticker (`utcDayKey`) that flushes
 * `cutoff` at midnight (codex finding 3183954662) and the precomputed
 * `rangeCutoffSeconds` value.
 */
export function useVolumeUrlState({
  canUseVolumeFilters,
}: VolumeUrlStateOptions): VolumeUrlStateResult {
  // `useSearchParams()` here is load-bearing for direct page loads —
  // `useState` lazy initializers serialize their result on SSR and don't
  // re-run on hydration, so reading `window.location.search` only would
  // discard `?range=90d&venue=v2` when a user lands on the page directly
  // (Cursor Bugbot bbc20b5f, PR #371). All consumers of this hook are
  // wrapped in <Suspense> at `app/layout.tsx` line 51 and at the route's
  // own `page.tsx`, so the rule's "wrap consumer in Suspense" guidance
  // is satisfied — the rule's static check just can't see across files.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();

  const initialReadParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;

  const [range, setRange] = useState<VolumeRangeKey>(() =>
    readRangeFromParams(initialReadParams),
  );
  const [actorFilter, setActorFilter] = useState<ActorFilter>(() =>
    canUseVolumeFilters ? readActorFilterFromParams(initialReadParams) : "all",
  );
  const [exclusions, setExclusions] = useState<VolumeExclusionState>(() =>
    canUseVolumeFilters
      ? readExclusionsFromParams(initialReadParams)
      : { addresses: [], sources: [] },
  );
  const [venue, setVenue] = useState<Venue>(() =>
    readVenueFromParams(initialReadParams),
  );

  const actions = useVolumeUrlActions({
    canUseVolumeFilters,
    range,
    actorFilter,
    exclusions,
    venue,
    setRange,
    setActorFilter,
    setExclusions,
    setVenue,
  });

  useVolumePopstateSync({
    canUseVolumeFilters,
    setRange,
    setActorFilter,
    setExclusions,
    setVenue,
  });
  useLockedVolumeFilterCanonicalization({ canUseVolumeFilters });
  const utcDayKey = useUtcDayKey();
  // Re-derive the public result as a final defense: state initialization and
  // action guards already lock anonymous users to total volume.
  const effectiveActorFilter: ActorFilter = canUseVolumeFilters
    ? actorFilter
    : "all";
  const effectiveExclusions: VolumeExclusionState = canUseVolumeFilters
    ? exclusions
    : { addresses: [], sources: [] };

  // `utcDayKey` is a dep so the cutoff re-derives at midnight even though
  // it's not referenced inside — `rangeCutoffSeconds` calls `Date.now()`
  // internally and the memo cache must flush when the day flips.
  const cutoff = useMemo(() => rangeCutoffSeconds(range), [range, utcDayKey]);

  return {
    canUseVolumeFilters,
    range,
    actorFilter: effectiveActorFilter,
    includeProtocolActors: effectiveActorFilter === "all",
    exclusions: effectiveExclusions,
    venue,
    cutoff,
    utcDayKey,
    ...actions,
  };
}

function useVolumeUrlActions({
  canUseVolumeFilters,
  range,
  actorFilter,
  exclusions,
  venue,
  setRange,
  setActorFilter,
  setExclusions,
  setVenue,
}: VolumeUrlActionInputs): Pick<
  VolumeUrlStateResult,
  | "updateRange"
  | "updateIncludeProtocolActors"
  | "updateExclusions"
  | "updateVenue"
> {
  const writeUrl = useCallback(
    (next: VolumeUrlSnapshot) => {
      writeVolumeUrl(next, canUseVolumeFilters);
    },
    [canUseVolumeFilters],
  );

  const updateRange = useCallback(
    (next: VolumeRangeKey) => {
      setRange(next);
      writeUrl({ range: next, actorFilter, exclusions, venue });
    },
    [actorFilter, exclusions, venue, writeUrl, setRange],
  );
  const updateIncludeProtocolActors = useCallback(
    (next: boolean) => {
      // Defense-in-depth: the actor toggle is only rendered when private
      // volume filters are available, so normal UI calls do not hit this path.
      if (!canUseVolumeFilters) {
        setActorFilter("all");
        writeUrl({ range, actorFilter: "all", exclusions, venue });
        return;
      }
      const nextActorFilter: ActorFilter = next ? "all" : "organic";
      setActorFilter(nextActorFilter);
      writeUrl({ range, actorFilter: nextActorFilter, exclusions, venue });
    },
    [canUseVolumeFilters, exclusions, range, venue, writeUrl, setActorFilter],
  );
  const updateExclusions = useCallback(
    (next: VolumeExclusionState) => {
      // Defense-in-depth: the exclusions panel is only rendered when private
      // volume filters are available, so normal UI calls do not hit this path.
      if (!canUseVolumeFilters) {
        const emptyExclusions = { addresses: [], sources: [] };
        setExclusions(emptyExclusions);
        writeUrl({
          range,
          actorFilter: "all",
          exclusions: emptyExclusions,
          venue,
        });
        return;
      }
      setExclusions(next);
      writeUrl({ range, actorFilter, exclusions: next, venue });
    },
    [actorFilter, canUseVolumeFilters, range, venue, writeUrl, setExclusions],
  );
  const updateVenue = useCallback(
    (next: Venue) => {
      setVenue(next);
      writeUrl({ range, actorFilter, exclusions, venue: next });
    },
    [actorFilter, exclusions, range, writeUrl, setVenue],
  );

  return {
    updateRange,
    updateIncludeProtocolActors,
    updateExclusions,
    updateVenue,
  };
}

function useVolumePopstateSync({
  canUseVolumeFilters,
  setRange,
  setActorFilter,
  setExclusions,
  setVenue,
}: VolumeUrlSetters & { canUseVolumeFilters: boolean }) {
  // Browser back/forward fires `popstate`. `replaceState` itself doesn't,
  // and `useSearchParams` doesn't observe our writes — popstate is the only
  // signal that real navigation moved the URL out from under us.
  // The 3 setters below all update from the same single URL snapshot in a
  // single event handler, so React's auto-batching collapses them to one
  // re-render. A useReducer rewrite would just rename the same operation.
  // react-doctor-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setRange((prev) => {
        const next = readRangeFromParams(params);
        return prev === next ? prev : next;
      });
      setActorFilter((prev) => {
        const next = canUseVolumeFilters
          ? readActorFilterFromParams(params)
          : "all";
        return prev === next ? prev : next;
      });
      setExclusions((prev) => {
        const next = canUseVolumeFilters
          ? readExclusionsFromParams(params)
          : { addresses: [], sources: [] };
        return exclusionsEqual(prev, next) ? prev : next;
      });
      setVenue((prev) => {
        const next = readVenueFromParams(params);
        return prev === next ? prev : next;
      });
      if (!canUseVolumeFilters) stripVolumeFilterParamsFromCurrentUrl();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [canUseVolumeFilters, setActorFilter, setExclusions, setRange, setVenue]);
}

function useLockedVolumeFilterCanonicalization({
  canUseVolumeFilters,
}: {
  canUseVolumeFilters: boolean;
}) {
  useEffect(() => {
    if (typeof window === "undefined" || canUseVolumeFilters) return;
    stripVolumeFilterParamsFromCurrentUrl();
  }, [canUseVolumeFilters]);
}

function stripVolumeFilterParamsFromCurrentUrl() {
  const params = new URLSearchParams(window.location.search);
  const changed =
    params.has("actors") ||
    params.has("exclude") ||
    params.has("excludeSources");
  if (!changed) return;
  params.delete("actors");
  params.delete("exclude");
  params.delete("excludeSources");
  replaceVolumeUrlSearch(params);
}

function useUtcDayKey(): number {
  // UTC-day rollover ticker. Polled every minute — cheap, and worst-case
  // drift between wall-clock midnight and the volume page updating is
  // < 1 minute. We can't `setTimeout` precisely to midnight because
  // backgrounded tabs throttle timers.
  const [utcDayKey, setUtcDayKey] = useState<number>(() =>
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => {
      setUtcDayKey((prev) => {
        const next = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return utcDayKey;
}

function exclusionsEqual(
  a: VolumeExclusionState,
  b: VolumeExclusionState,
): boolean {
  return listEqual(a.addresses, b.addresses) && listEqual(a.sources, b.sources);
}

function listEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
