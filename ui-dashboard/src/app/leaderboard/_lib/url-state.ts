"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  rangeCutoffSeconds,
  type LeaderboardRangeKey,
} from "@/lib/leaderboard";
import { SECONDS_PER_DAY } from "@/lib/time-series";

export type Venue = "v3" | "v2";

const VALID_RANGES = new Set<LeaderboardRangeKey>([
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
]);
const DEFAULT_RANGE: LeaderboardRangeKey = "7d";
const VALID_VENUES = new Set<Venue>(["v3", "v2"]);

function initialParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function readRangeFromParams(params: URLSearchParams): LeaderboardRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as LeaderboardRangeKey)
    ? (raw as LeaderboardRangeKey)
    : DEFAULT_RANGE;
}

function readShowSystemFromParams(params: URLSearchParams): boolean {
  return params.get("system") === "1";
}

function readVenueFromParams(params: URLSearchParams): Venue {
  const raw = params.get("venue");
  return raw && VALID_VENUES.has(raw as Venue) ? (raw as Venue) : "v3";
}

/**
 * URL-backed state for the leaderboard page (range / system toggle / venue).
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
export function useLeaderboardUrlState(): {
  range: LeaderboardRangeKey;
  showSystem: boolean;
  venue: Venue;
  cutoff: number;
  utcDayKey: number;
  updateRange: (next: LeaderboardRangeKey) => void;
  updateShowSystem: (next: boolean) => void;
  updateVenue: (next: Venue) => void;
} {
  // Read directly from `window.location.search` rather than via
  // `useSearchParams()` — the hook would force the leaderboard page out
  // of static rendering (and trip
  // `nextjs-no-use-search-params-without-suspense`) for an SSR pass that
  // never matters here: the page is `"use client"`, admin-only
  // (`robots: noindex`), and re-syncs via `popstate` after mount.
  const [range, setRange] = useState<LeaderboardRangeKey>(() =>
    readRangeFromParams(initialParams()),
  );
  const [showSystem, setShowSystem] = useState<boolean>(() =>
    readShowSystemFromParams(initialParams()),
  );
  const [venue, setVenue] = useState<Venue>(() =>
    readVenueFromParams(initialParams()),
  );

  const writeUrl = useCallback(
    (
      nextRange: LeaderboardRangeKey,
      nextShowSystem: boolean,
      nextVenue: Venue,
    ) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      if (nextRange === DEFAULT_RANGE) params.delete("range");
      else params.set("range", nextRange);
      if (nextShowSystem) params.set("system", "1");
      else params.delete("system");
      if (nextVenue === "v3") params.delete("venue");
      else params.set("venue", nextVenue);
      const qs = params.toString();
      const nextUrl =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
    },
    [],
  );

  const updateRange = useCallback(
    (next: LeaderboardRangeKey) => {
      setRange(next);
      writeUrl(next, showSystem, venue);
    },
    [showSystem, venue, writeUrl],
  );
  const updateShowSystem = useCallback(
    (next: boolean) => {
      setShowSystem(next);
      writeUrl(range, next, venue);
    },
    [range, venue, writeUrl],
  );
  const updateVenue = useCallback(
    (next: Venue) => {
      setVenue(next);
      writeUrl(range, showSystem, next);
    },
    [range, showSystem, writeUrl],
  );

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
      setShowSystem((prev) => {
        const next = readShowSystemFromParams(params);
        return prev === next ? prev : next;
      });
      setVenue((prev) => {
        const next = readVenueFromParams(params);
        return prev === next ? prev : next;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // UTC-day rollover ticker. Polled every minute — cheap, and worst-case
  // drift between wall-clock midnight and the leaderboard updating is
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

  // `utcDayKey` is a dep so the cutoff re-derives at midnight even though
  // it's not referenced inside — `rangeCutoffSeconds` calls `Date.now()`
  // internally and the memo cache must flush when the day flips.
  const cutoff = useMemo(() => rangeCutoffSeconds(range), [range, utcDayKey]);

  return {
    range,
    showSystem,
    venue,
    cutoff,
    utcDayKey,
    updateRange,
    updateShowSystem,
    updateVenue,
  };
}
