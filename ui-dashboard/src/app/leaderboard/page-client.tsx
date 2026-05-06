"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_LEADERBOARD,
  TRADER_DAILY_TOP,
} from "@/lib/queries/leaderboard";
import {
  LEADERBOARD_RANGES,
  aggregateBrokerAggregatorsByWindow,
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregateTradersByWindow,
  rangeCutoffSeconds,
  rangeDays,
  weiToUsd,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type LeaderboardRangeKey,
  type TraderDailyRow,
} from "@/lib/leaderboard";
import { SECONDS_PER_DAY, type RangeKey } from "@/lib/time-series";
import { LeaderboardTable } from "./_components/leaderboard-table";
import {
  V2LeaderboardAggregatorTable,
  V2LeaderboardTraderTable,
} from "./_components/v2-leaderboard-tables";

type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};

type Venue = "v3" | "v2";

const VALID_RANGES = new Set<LeaderboardRangeKey>(["24h", "7d", "30d", "all"]);
const VALID_VENUES = new Set<Venue>(["v3", "v2"]);

function readRangeFromParams(params: URLSearchParams): LeaderboardRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as LeaderboardRangeKey)
    ? (raw as LeaderboardRangeKey)
    : "7d";
}

function readShowSystemFromParams(params: URLSearchParams): boolean {
  return params.get("system") === "1";
}

function readVenueFromParams(params: URLSearchParams): Venue {
  const raw = params.get("venue");
  return raw && VALID_VENUES.has(raw as Venue) ? (raw as Venue) : "v3";
}

export function LeaderboardClient() {
  const searchParams = useSearchParams();

  // URL-backed state. Reads happen via `useSearchParams` on initial mount
  // (server-rendered + first client paint), but writes go through
  // `window.history.replaceState` — NOT `router.replace`. The App Router's
  // `router.replace` triggers an RSC payload refetch on the current segment
  // (`?_rsc=...`) every URL write, which adds ~700ms latency to range/filter
  // toggles. See AGENTS.md "URL state in client-only tables / filters" and
  // PR #314 for the regression that established this rule.
  const [range, setRange] = useState<LeaderboardRangeKey>(() =>
    readRangeFromParams(searchParams),
  );
  const [showSystem, setShowSystem] = useState<boolean>(() =>
    readShowSystemFromParams(searchParams),
  );
  const [venue, setVenue] = useState<Venue>(() =>
    readVenueFromParams(searchParams),
  );

  const writeUrl = useCallback(
    (
      nextRange: LeaderboardRangeKey,
      nextShowSystem: boolean,
      nextVenue: Venue,
    ) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      if (nextRange === "7d") params.delete("range");
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

  // Browser back/forward buttons fire `popstate`. `replaceState` itself
  // doesn't (and Next's `useSearchParams` doesn't observe our writes), so
  // popstate is the only signal that real navigation moved the URL out from
  // under us — sync local state when it happens.
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

  // `cutoff` only re-derives when `range` or the current UTC day changes.
  // Memoizing on `range` alone is not enough: `rangeCutoffSeconds` aligns
  // to UTC midnight, so a tab left open across midnight would keep firing
  // `_gte` queries against yesterday's boundary until the user reloaded
  // (codex finding 3183954662). We track UTC-day-of-mount via state and
  // bump it when a tick crosses midnight; the cache key flips at most
  // once per UTC day.
  const [utcDayKey, setUtcDayKey] = useState<number>(() =>
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Poll once per minute — cheap, and the worst-case visible drift between
    // wall-clock midnight and the leaderboard updating is < 1 minute. We
    // can't `setTimeout` precisely to midnight because the user's tab may
    // be backgrounded and timers get throttled.
    const id = window.setInterval(() => {
      setUtcDayKey((prev) => {
        const next = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  // `utcDayKey` is in the deps so the cutoff re-derives at midnight even
  // though it's not referenced inside the memo body — `rangeCutoffSeconds`
  // calls `Date.now()` internally and we need to flush the memo cache when
  // the day flips. Including the key is the cheapest way to express that.
  const cutoff = useMemo(() => rangeCutoffSeconds(range), [range, utcDayKey]);
  const isSystemAddressIn = useMemo(
    () => (showSystem ? [false, true] : [false]),
    [showSystem],
  );

  // Each venue's queries are gated to its tab so we don't burn Envio quota
  // on the side the user isn't looking at — same trick as `expanded ? Q : null`
  // in LeaderboardTable.TraderRow.
  const tradersResult = useGQL<{ TraderDailySnapshot: TraderDailyRow[] }>(
    venue === "v3" ? TRADER_DAILY_TOP : null,
    {
      afterTimestamp: cutoff,
      isSystemAddressIn,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const poolsResult = useGQL<{ Pool: PoolRow[] }>(
    venue === "v3" ? POOLS_FOR_LEADERBOARD : null,
    undefined,
    300_000, // pool metadata barely changes; refresh every 5 min
  );

  const v2TradersResult = useGQL<{
    BrokerTraderDailySnapshot: BrokerTraderDailyRow[];
  }>(venue === "v2" ? BROKER_TRADER_DAILY_TOP : null, {
    afterTimestamp: cutoff,
    isSystemAddressIn,
    limit: ENVIO_MAX_ROWS,
  });
  const v2AggregatorsResult = useGQL<{
    BrokerAggregatorDailySnapshot: BrokerAggregatorDailyRow[];
  }>(venue === "v2" ? BROKER_AGGREGATOR_DAILY_TOP : null, {
    afterTimestamp: cutoff,
    limit: ENVIO_MAX_ROWS,
  });

  const traderRows = tradersResult.data?.TraderDailySnapshot ?? [];
  const poolRows = poolsResult.data?.Pool ?? [];
  const v2TraderRows = v2TradersResult.data?.BrokerTraderDailySnapshot ?? [];
  const v2AggregatorRows =
    v2AggregatorsResult.data?.BrokerAggregatorDailySnapshot ?? [];

  const aggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
    [traderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(traderRows),
    [traderRows],
  );
  const v2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(v2TraderRows),
    [v2TraderRows],
  );
  const v2AggregatorAggregated = useMemo(
    () => aggregateBrokerAggregatorsByWindow(v2AggregatorRows),
    [v2AggregatorRows],
  );
  const v2DailyVolume = useMemo(
    () => aggregateDailyVolume(v2TraderRows),
    [v2TraderRows],
  );

  // Lower-cased pool id keying so the table can look up
  // `${chainId}-${poolAddress}` regardless of how the indexer cased it.
  const poolMeta = useMemo(() => {
    const m = new Map<
      string,
      { token0: string | null; token1: string | null }
    >();
    for (const p of poolRows) {
      m.set(p.id.toLowerCase(), { token0: p.token0, token1: p.token1 });
    }
    return m;
  }, [poolRows]);

  // Hero KPIs — switch the source list by venue. The KPI shapes are
  // identical between v3 and v2 (volume / traders / top-10 concentration /
  // swap count), so we pick one input array and the math below is unified.
  const kpiSource = venue === "v3" ? aggregated : v2Aggregated;

  const totalVolume = useMemo(() => {
    let acc = BigInt(0);
    for (const t of kpiSource) acc += t.volumeUsdWei;
    return weiToUsd(acc);
  }, [kpiSource]);

  const totalTraders = kpiSource.length;
  const totalSwaps = useMemo(
    () => kpiSource.reduce((acc, t) => acc + t.swapCount, 0),
    [kpiSource],
  );
  const top10Concentration = useMemo(() => {
    if (kpiSource.length === 0) return 0;
    let total = BigInt(0);
    let top10 = BigInt(0);
    for (let i = 0; i < kpiSource.length; i += 1) {
      total += kpiSource[i]!.volumeUsdWei;
      if (i < 10) top10 += kpiSource[i]!.volumeUsdWei;
    }
    if (total === BigInt(0)) return 0;
    return Number((top10 * BigInt(10000)) / total) / 100;
  }, [kpiSource]);

  // The TimeSeriesChartCard takes a 7d/30d/all RangeKey. Map the leaderboard
  // range onto the chart's range — both 24h and 7d show the 7d view (the
  // chart can't render a single-day point as a meaningful series anyway).
  const chartRange: RangeKey =
    range === "30d" ? "30d" : range === "all" ? "all" : "7d";
  const onChartRangeChange = useCallback(
    (next: RangeKey) => {
      updateRange(next === "all" ? "all" : next === "30d" ? "30d" : "7d");
    },
    [updateRange],
  );

  // Page chrome / KPIs / chart / producer table all read from the
  // trader-side query for the active venue. The v2 aggregator query is
  // independent — its loading/error feed only the aggregator table below
  // so a slow or erroring `BrokerAggregatorDailySnapshot` (e.g. during the
  // post-deploy resync window for that new entity) doesn't take down the
  // producer view that's the actual outreach driver. Codex review:
  // https://github.com/mento-protocol/monitoring-monorepo/pull/324#discussion_r3195117172
  const isLoading =
    venue === "v3"
      ? tradersResult.isLoading || poolsResult.isLoading
      : v2TradersResult.isLoading;
  const hasError =
    venue === "v3" ? !!tradersResult.error : !!v2TradersResult.error;
  const v2AggIsLoading = v2AggregatorsResult.isLoading;
  const v2AggHasError = !!v2AggregatorsResult.error;
  // True iff the trader-day query saturated the Hasura cap. When this is
  // set, `aggregated` and the derived KPIs may be undercounting; we badge
  // them with `≈` and surface a banner above the tiles. Same approximation
  // semantics for v2 — the cap applies to BrokerTraderDailySnapshot too.
  const isCapHit =
    venue === "v3"
      ? !!tradersResult.data &&
        (tradersResult.data.TraderDailySnapshot?.length ?? 0) === ENVIO_MAX_ROWS
      : !!v2TradersResult.data &&
        (v2TradersResult.data.BrokerTraderDailySnapshot?.length ?? 0) ===
          ENVIO_MAX_ROWS;

  // Headline = window total. Change pill is week-over-week if the range is
  // ≥7d, otherwise null (24h has no meaningful WoW peer).
  const headline = isLoading || hasError ? "" : formatUSD(totalVolume);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-white">
            Volume Leaderboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {venue === "v3"
              ? "Top traders on Mento by USD volume — system addresses hidden by default."
              : "Top legacy-v2 producers — wallets and integrators we want to migrate to v3."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Venue"
            className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
          >
            {(["v3", "v2"] as const).map((v) => {
              const active = venue === v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateVenue(v)}
                  className={
                    "rounded px-3 py-1 text-xs font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                    (active
                      ? "bg-slate-700 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200")
                  }
                >
                  {v}
                </button>
              );
            })}
          </div>
          <div
            role="group"
            aria-label="Time window"
            className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
          >
            {LEADERBOARD_RANGES.map((r) => {
              const active = range === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateRange(r.key)}
                  className={
                    "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                    (active
                      ? "bg-slate-700 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200")
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => updateShowSystem(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
            />
            Show system addresses
          </label>
        </div>
      </header>

      {/* The 1000-row cap on `TRADER_DAILY_TOP` is shared by the tiles, the
          daily-volume chart, AND the table — surface the warning above the
          tiles, not just below the table, so users don't read the totals
          and concentration percentage as exact when they're approximate. */}
      {isCapHit && (
        <div className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90">
          <strong className="font-medium">
            Approximate values for this window.
          </strong>{" "}
          Showing the top {ENVIO_MAX_ROWS.toLocaleString()} trader-day rows by
          single-day volume — total volume, unique-trader count, top-10
          concentration, and the daily-volume chart all derive from this cap.
          High-frequency traders whose individual days don&apos;t crack the cap
          may be undercounted at longer windows. A pre-rolled window-snapshot
          entity is planned (<code>BACKLOG.md</code> &rarr; PR 4).
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label={isCapHit ? "Total volume (≈)" : "Total volume"}
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${isCapHit ? "≈ " : ""}${formatUSD(totalVolume)}`
          }
          subtitle={rangeSubtitle(range)}
        />
        <Tile
          label={isCapHit ? "Unique traders (≈)" : "Unique traders"}
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${isCapHit ? "≥ " : ""}${totalTraders.toLocaleString()}`
          }
          subtitle={`${totalSwaps.toLocaleString()} swaps`}
        />
        <Tile
          label={isCapHit ? "Top-10 concentration (≈)" : "Top-10 concentration"}
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${top10Concentration.toFixed(1)}%`
          }
          subtitle="Share of window volume"
        />
      </div>

      {/* The chart only makes sense with multi-day data — the 24h window
          collapses to a single point and the chart's "1W / 1M / All" pill
          row would mismatch the visible series. */}
      {range !== "24h" && (
        <TimeSeriesChartCard
          title={
            venue === "v3" ? "Daily traded volume" : "Daily v2 traded volume"
          }
          rangeAriaLabel="Chart range"
          series={venue === "v3" ? dailyVolume : v2DailyVolume}
          range={chartRange}
          onRangeChange={onChartRangeChange}
          headline={headline}
          change={null}
          isLoading={isLoading}
          hasError={hasError}
          hasSnapshotError={false}
          emptyMessage={
            venue === "v3"
              ? "No trader volume in this window."
              : "No legacy-v2 volume in this window."
          }
        />
      )}

      {venue === "v3" ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-slate-300">
            Top traders ({rangeLabel(range)})
          </h2>
          <LeaderboardTable
            cutoff={cutoff}
            traders={aggregated}
            pools={poolMeta}
            isLoading={isLoading}
            hasError={hasError}
          />
        </section>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-sm font-medium text-slate-300">
              Top v2 producers ({rangeLabel(range)})
            </h2>
            <V2LeaderboardTraderTable
              traders={v2Aggregated}
              isLoading={isLoading}
              hasError={hasError}
            />
          </section>
          <section>
            <h2 className="mb-3 text-sm font-medium text-slate-300">
              v2 volume by aggregator / entry-point ({rangeLabel(range)})
            </h2>
            <p className="mb-3 text-xs text-slate-500">
              Canonical name from <code>aggregators.json</code>. Large{" "}
              <span className="rounded bg-amber-900/40 px-1 py-px text-amber-200">
                unknown
              </span>{" "}
              rows are unclassified routers — file an entry to label them and
              reach out to the operator about migrating to v3.
            </p>
            <V2LeaderboardAggregatorTable
              aggregators={v2AggregatorAggregated}
              isLoading={v2AggIsLoading}
              hasError={v2AggHasError}
            />
          </section>
        </>
      )}
    </div>
  );
}

function rangeSubtitle(range: LeaderboardRangeKey): string {
  if (range === "all") return "All time";
  const days = rangeDays(range);
  // The 24h window aligns to today's UTC bucket (`rangeCutoffSeconds`),
  // not a rolling 24h. At 03:00 UTC that's 3 hours of data, not 24 — so
  // labeling it "Last 24 hours" was confidently wrong. "Today (UTC)"
  // matches what the cutoff actually selects.
  if (days === 1) return "Today (UTC)";
  return `Last ${days} days`;
}

function rangeLabel(range: LeaderboardRangeKey): string {
  if (range === "24h") return "24h";
  if (range === "7d") return "7d";
  if (range === "30d") return "30d";
  return "all-time";
}
