"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import { rangeCutoffSeconds, type VolumeRangeKey } from "@/lib/volume";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import {
  activeChainIds,
  configuredProductionChainOptions,
  type ChainFilterOption,
  type ChainFilterValue,
} from "@/lib/chain-filter";
import { useUrlChainFilter } from "@/hooks/use-url-chain-filter";
// Pure param parsing is shared with the /volume Server Component (SSR
// prefetch must derive the identical first-render view) — see
// lib/volume-url-params.ts. This module stays the client-side owner of
// URL writes + state sync.
import {
  DEFAULT_ACTOR_FILTER,
  DEFAULT_RANGE,
  readActorFilterFromParams,
  readRangeFromParams,
  readVenueFromParams,
  type ActorFilter,
  type Venue,
} from "@/lib/volume-url-params";

export type { Venue } from "@/lib/volume-url-params";
type VolumeUrlSnapshot = {
  range: VolumeRangeKey;
  actorFilter: ActorFilter;
  venue: Venue;
};
type VolumeUrlSetters = {
  setRange: Dispatch<SetStateAction<VolumeRangeKey>>;
  setActorFilter: Dispatch<SetStateAction<ActorFilter>>;
  setVenue: Dispatch<SetStateAction<Venue>>;
};
type VolumeUrlActionInputs = VolumeUrlSetters &
  VolumeUrlSnapshot & {
    canUseVolumeFilters: boolean;
  };
type VolumeUrlStateOptions = {
  canUseVolumeFilters: boolean;
  chainOptions?: readonly ChainFilterOption[] | undefined;
  initialUtcDayKey?: number | undefined;
};
type VolumeUrlStateResult = {
  canUseVolumeFilters: boolean;
  range: VolumeRangeKey;
  actorFilter: ActorFilter;
  includeProtocolActors: boolean;
  venue: Venue;
  chainId: ChainFilterValue;
  chainIdIn: number[];
  chainOptions: readonly ChainFilterOption[];
  cutoff: number;
  utcDayKey: number;
  updateRange: (next: VolumeRangeKey) => void;
  updateIncludeProtocolActors: (next: boolean) => void;
  updateVenue: (next: Venue) => void;
  updateChainId: (next: ChainFilterValue) => void;
};

function writeVolumeUrl(
  { range, actorFilter, venue }: VolumeUrlSnapshot,
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
  params.delete("exclude");
  params.delete("excludeSources");
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
 * URL-backed state for the volume page (range / actor filter / venue).
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
  chainOptions: chainOptionsOverride,
  initialUtcDayKey,
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
  const chainOptions = useMemo(
    () => chainOptionsOverride ?? configuredProductionChainOptions(),
    [chainOptionsOverride],
  );
  const { chainId, updateChainId } = useUrlChainFilter(chainOptions);
  const chainIdIn = useMemo(
    () => activeChainIds(chainId, chainOptions),
    [chainId, chainOptions],
  );

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
  const [venue, setVenue] = useState<Venue>(() =>
    readVenueFromParams(initialReadParams),
  );

  const actions = useVolumeUrlActions({
    canUseVolumeFilters,
    range,
    actorFilter,
    venue,
    setRange,
    setActorFilter,
    setVenue,
  });

  useVolumePopstateSync({
    canUseVolumeFilters,
    setRange,
    setActorFilter,
    setVenue,
  });
  useVolumeFilterCanonicalization({ canUseVolumeFilters });
  const utcDayKey = useUtcDayKey(initialUtcDayKey);
  // Re-derive the public result as a final defense: state initialization and
  // action guards already lock anonymous users to total volume.
  const effectiveActorFilter: ActorFilter = canUseVolumeFilters
    ? actorFilter
    : "all";

  // Derive from the same explicit day key used by the hero queries. Reading
  // `Date.now()` again here would reopen a midnight race between sibling
  // query identities during hydration.
  const cutoff = useMemo(
    () => rangeCutoffSeconds(range, utcDayKey * SECONDS_PER_DAY),
    [range, utcDayKey],
  );

  return {
    canUseVolumeFilters,
    range,
    actorFilter: effectiveActorFilter,
    includeProtocolActors: effectiveActorFilter === "all",
    venue,
    chainId,
    chainIdIn,
    chainOptions,
    cutoff,
    utcDayKey,
    ...actions,
    updateChainId,
  };
}

function useVolumeUrlActions({
  canUseVolumeFilters,
  range,
  actorFilter,
  venue,
  setRange,
  setActorFilter,
  setVenue,
}: VolumeUrlActionInputs): Pick<
  VolumeUrlStateResult,
  "updateRange" | "updateIncludeProtocolActors" | "updateVenue"
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
      writeUrl({ range: next, actorFilter, venue });
    },
    [actorFilter, venue, writeUrl, setRange],
  );
  const updateIncludeProtocolActors = useCallback(
    (next: boolean) => {
      // Defense-in-depth: the actor toggle is only rendered when private
      // volume filters are available, so normal UI calls do not hit this path.
      if (!canUseVolumeFilters) {
        setActorFilter("all");
        writeUrl({ range, actorFilter: "all", venue });
        return;
      }
      const nextActorFilter: ActorFilter = next ? "all" : "organic";
      setActorFilter(nextActorFilter);
      writeUrl({ range, actorFilter: nextActorFilter, venue });
    },
    [canUseVolumeFilters, range, venue, writeUrl, setActorFilter],
  );
  const updateVenue = useCallback(
    (next: Venue) => {
      setVenue(next);
      writeUrl({ range, actorFilter, venue: next });
    },
    [actorFilter, range, writeUrl, setVenue],
  );

  return {
    updateRange,
    updateIncludeProtocolActors,
    updateVenue,
  };
}

function useVolumePopstateSync({
  canUseVolumeFilters,
  setRange,
  setActorFilter,
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
      setVenue((prev) => {
        const next = readVenueFromParams(params);
        return prev === next ? prev : next;
      });
      if (canUseVolumeFilters) stripRetiredVolumeFilterParamsFromCurrentUrl();
      else stripLockedVolumeFilterParamsFromCurrentUrl();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [canUseVolumeFilters, setActorFilter, setRange, setVenue]);
}

function useVolumeFilterCanonicalization({
  canUseVolumeFilters,
}: {
  canUseVolumeFilters: boolean;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (canUseVolumeFilters) stripRetiredVolumeFilterParamsFromCurrentUrl();
    else stripLockedVolumeFilterParamsFromCurrentUrl();
  }, [canUseVolumeFilters]);
}

function stripLockedVolumeFilterParamsFromCurrentUrl() {
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

function stripRetiredVolumeFilterParamsFromCurrentUrl() {
  const params = new URLSearchParams(window.location.search);
  const changed = params.has("exclude") || params.has("excludeSources");
  if (!changed) return;
  params.delete("exclude");
  params.delete("excludeSources");
  replaceVolumeUrlSearch(params);
}

function useUtcDayKey(initialUtcDayKey?: number): number {
  // UTC-day rollover ticker. Polled every minute — cheap, and worst-case
  // drift between wall-clock midnight and the volume page updating is
  // < 1 minute. We can't `setTimeout` precisely to midnight because
  // backgrounded tabs throttle timers.
  const getServerSnapshot = useCallback(
    () => initialUtcDayKey ?? currentUtcDayKey(),
    [initialUtcDayKey],
  );
  // React uses the server snapshot for hydration, then compares it with the
  // browser clock before paint completes. This keeps the first render stable
  // without mirroring external clock state through an effect.
  return useSyncExternalStore(
    subscribeToUtcDay,
    currentUtcDayKey,
    getServerSnapshot,
  );
}

function currentUtcDayKey(): number {
  return Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
}

function subscribeToUtcDay(onStoreChange: () => void): () => void {
  const id = window.setInterval(onStoreChange, 60_000);
  return () => window.clearInterval(id);
}
