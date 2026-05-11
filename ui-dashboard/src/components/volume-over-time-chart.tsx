"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import {
  getSnapshotVolumeInUsd,
  snapshotWindow7d,
  snapshotWindow30d,
  type TimeRange,
} from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import {
  TimeSeriesChartCard,
  type BreakdownSeries,
} from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

type SeriesPoint = { timestamp: number; volumeUSD: number };

export type VolumePartialState = boolean | null;

export type DailyVolumeSeriesResult = {
  series: SeriesPoint[];
  byChain: Array<{
    network: Network;
    series: SeriesPoint[];
  }>;
  /**
   * Trust-state of the v3 volume series:
   * - `null` — only untrusted-decimal snapshots were present, so render v3 as unavailable
   * - `false` — no snapshots were skipped for decimal-trust reasons
   * - `true` — at least one untrusted-decimal snapshot was skipped
   */
  volumePartial: VolumePartialState;
};
type ChainVolumeSeries = DailyVolumeSeriesResult["byChain"][number];

// Mento-protocol indigo for v3 (Router-driven) and a teal contrast for v2
// (legacy Broker → BiPoolManager). v3 dominates today, so it sits at the
// bottom of the stack and uses the brand color; v2 stacks on top in a
// distinct teal so the gap reads at a glance even when small.
//
// Pill foreground/background pair: the chart trace uses `color` directly
// (saturated, on slate-900). The headline pill uses the lighter `pillFg`
// (Tailwind indigo-200 / teal-200) on the matching `pillBg` (same hue at
// 35% alpha — `59` appended = 0x59/0xff ≈ 0.35). The lighter foreground is
// what keeps WCAG AA contrast against the tinted background — `color` on
// `${color}59` over slate-900 lands at ~2.6:1, below 4.5:1 for small text.
const VERSION_STYLE = {
  v3: {
    label: "v3",
    color: "#6366f1", // indigo-500 — saturated for the trace fill
    pillFg: "#c7d2fe", // indigo-200 — readable on the tinted pill bg
    pillBg: "#6366f159", // indigo-500 @ 35% alpha
  },
  v2: {
    label: "v2",
    color: "#14b8a6", // teal-500
    pillFg: "#99f6e4", // teal-200
    pillBg: "#14b8a659", // teal-500 @ 35% alpha
  },
} as const;
type Version = keyof typeof VERSION_STYLE;
const V3_COLOR = VERSION_STYLE.v3.color;
const V2_COLOR = VERSION_STYLE.v2.color;

// 1e16 — divide BigInt USD-wei by this to land in "cent" units that fit in
// Number safely above MAX_SAFE_INTEGER. Hoisted out of `buildBrokerDailyV2Series`
// so it's not recomputed per row. ES2017 target prevents BigInt literals.
const USD_WEI_PER_CENT = BigInt(10) ** BigInt(16);

/**
 * Includes swap volume from every pool type (FPMM and virtual), matching the
 * Summary tile's volume totals. Virtual pools also emit PoolDailySnapshot
 * rows with per-day swapVolume0/1, so excluding them would silently undercount
 * protocol volume and desync the chart from its Summary-tile counterpart.
 *
 * Input is the indexer's PoolDailySnapshot rollup (one row per pool per UTC
 * day). Each row's `timestamp` is the start of its UTC-day bucket and its
 * volume is the total for the full day.
 *
 * When `window` is provided only buckets whose timestamp falls strictly inside
 * the half-open window `[window.from, window.to)` are included. Because
 * `window.from` is an hour boundary (not midnight), the first UTC-day bucket
 * is included only when it starts at or after `window.from`, which means a
 * refresh at 10:00 UTC on day D shows the last 7 full days starting from day
 * D-7 (midnight). The chart's headline total therefore matches the exact
 * rolling-window period implied by the selected range tab.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): DailyVolumeSeriesResult {
  type PerChain = {
    network: Network;
    bucketTotals: Map<number, number>;
  };
  // Keyed by Network.id so distinct configured networks that share a chainId
  // (e.g. celo-mainnet vs celo-mainnet-local) stay separate in the breakdown.
  const perChain = new Map<string, PerChain>();
  const totalBuckets = new Map<number, number>();
  let minSnapshotBucket = Infinity;
  let skippedUntrustedDecimalSnapshot = false;

  for (const netData of networkData) {
    // Only skip on top-level failure. `snapshotsAllDailyError` may be set
    // while `snapshotsAllDaily` still carries preserved recent rows (fail-open
    // path for mid-loop pagination failure) — use those rows, the caller
    // shows a partial-data badge separately.
    if (netData.error !== null) continue;
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshotsAllDaily) {
      const timestamp = Number(snapshot.timestamp);
      if (window) {
        if (timestamp < window.from || timestamp >= window.to) continue;
      }
      const pool = poolById.get(snapshot.poolId);
      if (pool && pool.tokenDecimalsKnown !== true) {
        skippedUntrustedDecimalSnapshot = true;
        continue;
      }
      const volume = getSnapshotVolumeInUsd(
        snapshot,
        pool,
        netData.network,
        netData.rates,
      );
      if (volume === null) continue;
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minSnapshotBucket = Math.min(minSnapshotBucket, bucket);
      totalBuckets.set(bucket, (totalBuckets.get(bucket) ?? 0) + volume);
      let entry = perChain.get(netData.network.id);
      if (!entry) {
        entry = { network: netData.network, bucketTotals: new Map() };
        perChain.set(netData.network.id, entry);
      }
      entry.bucketTotals.set(
        bucket,
        (entry.bucketTotals.get(bucket) ?? 0) + volume,
      );
    }
  }

  const volumePartial = skippedUntrustedDecimalSnapshot
    ? Number.isFinite(minSnapshotBucket)
      ? true
      : null
    : false;

  if (!Number.isFinite(minSnapshotBucket))
    return { series: [], byChain: [], volumePartial };

  // Use ceil so the emission range starts at the first full UTC day that begins
  // at or after window.from — prevents a synthetic zero bar for any partial day
  // whose bucket starts before window.from but was excluded by the strict filter.
  const startBucket = window
    ? Math.ceil(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minSnapshotBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // When window.to lands exactly on a UTC-day boundary the bucket at endBucket
  // starts at window.to and is excluded by the strict filter (timestamp >=
  // window.to), so we clamp the loop to avoid an empty bar there. When window.to
  // is mid-day (the production case from hourBucket(Date.now())) endRef >
  // endBucket and we emit today's bucket — PoolDailySnapshot is incremental, so
  // today's row contains only swaps seen so far today, which is valid in-window data.
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  const byChain: ChainVolumeSeries[] = Array.from(perChain.values()).map(
    (entry) => ({ network: entry.network, series: [] }),
  );
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: totalBuckets.get(timestamp) ?? 0 });
    let i = 0;
    for (const entry of perChain.values()) {
      byChain[i].series.push({
        timestamp,
        volumeUSD: entry.bucketTotals.get(timestamp) ?? 0,
      });
      i++;
    }
  }
  return { series, byChain, volumePartial };
}

/**
 * Aggregate per-chain `brokerSnapshotsAllDaily` rows into a single daily
 * USD-volume series for legacy v2 traffic (Broker → BiPoolManager). Rows are
 * already filtered server-side to `routedViaV3Router=false`, so summing them
 * directly gives the v2 number without re-checking the v3-Router siblings.
 *
 * Same windowing semantics as `buildDailyVolumeSeries`: a `window` filters
 * rows to `[window.from, window.to)` and the emitted series zero-fills any
 * empty UTC-day bucket inside the window so the stack alignment with the v3
 * series stays correct.
 */
export function buildBrokerDailyV2Series(
  networkData: NetworkData[],
  window?: TimeRange,
): SeriesPoint[] {
  const totalBuckets = new Map<number, number>();
  let minBucket = Infinity;
  for (const netData of networkData) {
    if (netData.error !== null) continue;
    for (const row of netData.brokerSnapshotsAllDaily) {
      const timestamp = Number(row.timestamp);
      if (window && (timestamp < window.from || timestamp >= window.to))
        continue;
      // 18-decimal "USD-wei" → JS number USD, with cent-precision preserved.
      // `Number(BigInt(volumeUsdWei))` overflows MAX_SAFE_INTEGER (~9e15) for
      // any daily v2 volume above ~$10K, silently losing precision. Divide in
      // BigInt down to "cents" first so the result fits in Number, then scale
      // back to USD. Sub-cent precision is sacrificed (fine for $K/$M chart).
      const usd = Number(BigInt(row.volumeUsdWei) / USD_WEI_PER_CENT) / 100;
      // The indexer's `dayBucket()` already rounds `BrokerDailySnapshot.timestamp`
      // to UTC midnight, so this floor is a no-op in practice — kept defensive
      // so an upstream timestamp shift can't desync v2 / v3 stack alignment.
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minBucket = Math.min(minBucket, bucket);
      totalBuckets.set(bucket, (totalBuckets.get(bucket) ?? 0) + usd);
    }
  }
  if (!Number.isFinite(minBucket)) return [];

  const startBucket = window
    ? Math.ceil(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: totalBuckets.get(timestamp) ?? 0 });
  }
  return series;
}

/**
 * Week-over-week % change: sum of the last 7 completed UTC days vs the 7 days
 * before that. The final bucket in `fullSeries` is usually the partial current
 * UTC day (still filling up), so the comparison excludes it and uses the
 * trailing [-8, -1] vs [-15, -8] windows. Returns null when history is too
 * short or the prior window was zero.
 */
export function weekOverWeekChangePct(
  series: TimeSeriesPoint[],
): number | null {
  if (series.length < 15) return null;
  const last7 = series.slice(-8, -1);
  const prior7 = series.slice(-15, -8);
  const sum = (arr: TimeSeriesPoint[]) =>
    arr.reduce((total, point) => total + point.value, 0);
  const prior = sum(prior7);
  if (prior <= 0) return null;
  return ((sum(last7) - prior) / prior) * 100;
}

// Tiny pill rendered after each $-value in the headline so "v3" / "v2" labels
// don't compete typographically with the dollar amount the user is reading.
// Caller picks the version; foreground/background/label come from
// `VERSION_STYLE` so the pill can't drift out of sync with its matching
// breakdown trace. `aria-hidden` because the parent headline span carries
// the human-readable `aria-label` for assistive tech (the pill is decorative
// alongside the dollar value).
function VersionBadge({ version }: { version: Version }): ReactNode {
  const { label, pillFg, pillBg } = VERSION_STYLE[version];
  // Absolute positioning keeps the pill out of inline flow so its
  // margin-box can't extend the headline's line-box. With the pill
  // inline + `align-text-top` the line-box grew ~4px (the pill's top
  // sits above the line-box's natural top via half-leading), making the
  // Volume headline 4px taller than the adjacent TVL card and shifting
  // the digits 2-3px lower. Absolute positioning sidesteps the whole
  // line-box accounting — the pill renders inside its `relative`
  // wrapper but takes zero inline space. The wrapper reserves
  // horizontal room with `pr-9` so the dollar amount doesn't run into
  // the pill.
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: pillBg, color: pillFg }}
      className="absolute right-0 top-1.5 inline-flex items-center rounded px-1.5 py-px font-mono text-[10px] font-medium uppercase leading-none tracking-wide sm:text-xs"
    >
      {label}
    </span>
  );
}

// Show "N/A" only on explicit failure. An empty series without errors
// legitimately sums to $0 (no volume yet) — flagging it N/A would conflate
// "no activity" with "data missing".
//
// `hasBrokerSnapshotError` is split out from the combined `hasSnapshotError`
// so a Broker query failure / pagination cap renders v2 as "—" (data
// unavailable) without poisoning the v3 number, which is fetched from a
// different rollup. Otherwise a confident "$X v3 · $0 v2" misleads on every
// Broker outage even when v3 is fully synced.
function computeHeadline(
  isLoading: boolean,
  hasError: boolean,
  hasSnapshotError: boolean,
  hasBrokerSnapshotError: boolean,
  v3Partial: VolumePartialState,
  v3Points: SeriesPoint[],
  v2Points: SeriesPoint[],
  v3Total: number,
  v2Total: number,
): ReactNode {
  if (isLoading) return "…";
  if (hasError) return "N/A";
  if (hasSnapshotError && v3Points.length === 0 && v2Points.length === 0)
    return "N/A";
  const v3Display =
    v3Partial === null
      ? "—"
      : v3Partial
        ? `≈ ${formatUSD(v3Total)}`
        : formatUSD(v3Total);
  // Visual layout has no whitespace/punctuation between values and pill
  // badges, and gap-x-3 between the v3 and v2 cells is rendering-only.
  // Without an explicit `aria-label`, screen readers read the headline as
  // "$3.00v3$0.00v2"; the explicit label restores the original
  // "$X v3 · $Y v2" reading.
  const v2Display = hasBrokerSnapshotError ? "—" : formatUSD(v2Total);
  const v3AriaLabel =
    v3Partial === null
      ? "— v3"
      : v3Partial
        ? `approximately ${formatUSD(v3Total)} partial v3`
        : `${formatUSD(v3Total)} v3`;
  const ariaLabel = `${v3AriaLabel} · ${v2Display} v2`;
  // `role="group"` is required: a bare `<span>` has the implicit `generic`
  // role, which doesn't honor `aria-label` per WAI-ARIA. NVDA/JAWS skip the
  // label and the headline becomes silent for screen-reader users (every
  // child is `aria-hidden`). `group` carries the `name-from-author`
  // property so the label is announced.
  // Wrapper is plain inline (NOT inline-flex): inline-flex gave the wrapper
  // its own line-box, which sized to max(digit ascent, pill ascent) and
  // ended up ~4px taller than the TVL card's plain-text headline next to
  // it on the homepage row. Plain inline lets each cell flow inside the
  // parent `<p>`'s text line-box, so both headlines share the same height
  // and baseline. `mx-3` on the dot replaces the former `gap-x-3` for
  // horizontal spacing between cells.
  // Each cell is `relative` to anchor its absolutely-positioned pill, and
  // `pr-9` reserves horizontal room for the pill so the dollar amount
  // doesn't render under it. `title` gives sighted users an explainer on
  // hover; the parent's `aria-label` already covers screen readers.
  return (
    <span role="group" aria-label={ariaLabel}>
      <span
        aria-hidden="true"
        title={
          v3Partial === null
            ? "New Mento (v3): unavailable because token decimals are unverified for every v3 pool in this window."
            : v3Partial
              ? "New Mento (v3): partial because one or more pool snapshots were skipped until token decimals are verified."
              : "New Mento (v3): swaps routed through the v3 Router — the path used by app.mento.org today."
        }
        className="relative pr-9"
      >
        {v3Display}
        <VersionBadge version="v3" />
      </span>
      {/* CSS-drawn dot rather than a `·` glyph (U+00B7 renders ~5px below
          its line-box's geometric center in most fonts). The translate
          compensates for `align-middle` placing the dot at x-height/2 above
          baseline, while the digit ink midline sits closer to cap-height/2
          — for monospace digits at 36px that's a ~5px upward nudge. */}
      <span
        aria-hidden="true"
        className="mx-3 inline-block size-1.5 -translate-y-[5px] rounded-full bg-slate-500 align-middle"
      />
      <span
        aria-hidden="true"
        title="Legacy Mento (v2): direct Broker swaps that bypass the v3 Router — older integrations and routers calling Broker directly."
        className="relative pr-9"
      >
        {v2Display}
        <VersionBadge version="v2" />
      </span>
    </span>
  );
}

interface VolumeOverTimeChartProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
  /**
   * True when the Broker rollup query failed or its pagination truncated
   * before reaching the visible window. Renders "— v2" so a Broker outage
   * doesn't masquerade as a confident `$0 v2` when v3 loaded normally.
   */
  hasBrokerSnapshotError: boolean;
  fullVolumeSeries: DailyVolumeSeriesResult;
}

// Same independent-flags rationale as FeeOverTimeChart — see that file.
// react-doctor-disable-next-line react-doctor/no-many-boolean-props
export function VolumeOverTimeChart({
  networkData,
  isLoading,
  hasError,
  hasSnapshotError,
  hasBrokerSnapshotError,
  fullVolumeSeries,
}: VolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  // v3 WoW pill — v2 has a separate trajectory but is much smaller today, so
  // tracking the dominant-side delta keeps the headline meaningful. v2 WoW
  // can be added once v2 volumes are large enough to read at chart scale.
  const fullV3Series = useMemo<TimeSeriesPoint[]>(
    () =>
      fullVolumeSeries.series.map((p) => ({
        timestamp: p.timestamp,
        value: p.volumeUSD,
      })),
    [fullVolumeSeries],
  );

  const activeWindow = useMemo<TimeRange | undefined>(() => {
    if (range === "all") return undefined;
    // All networks are fetched together by `fetchAllNetworks`, so their
    // `snapshotWindows` are anchored at the same hour boundary — taking
    // index 0 is representative. Falls back to a fresh `Date.now()` window
    // only on cold-start before the first SWR fetch resolves.
    const fetchWindows = networkData[0]?.snapshotWindows;
    return fetchWindows
      ? range === "7d"
        ? fetchWindows.w7d
        : fetchWindows.w30d
      : range === "7d"
        ? snapshotWindow7d(Date.now())
        : snapshotWindow30d(Date.now());
  }, [networkData, range]);

  // v3 series for the active window — reuses fullV3Result on the "all" tab
  // since the window matches.
  const visibleV3Result = useMemo<DailyVolumeSeriesResult>(
    () =>
      range === "all"
        ? fullVolumeSeries
        : buildDailyVolumeSeries(networkData, activeWindow),
    [networkData, range, activeWindow, fullVolumeSeries],
  );
  const visibleV3Points = visibleV3Result.series;
  const visibleVolumePartial = visibleV3Result.volumePartial;

  // v2 series for the active window — sourced from BrokerDailySnapshot
  // (already filtered to routedViaV3Router=false server-side). Empty until
  // the indexer's Broker handler is deployed and resyncs.
  const visibleV2Points = useMemo<SeriesPoint[]>(
    () => buildBrokerDailyV2Series(networkData, activeWindow),
    [networkData, activeWindow],
  );

  // Stack v3 (bottom) + v2 (top). Distinct, named legend entries; the chart
  // card suppresses its own total trace in `stacked` mode so the breakdown
  // areas read directly.
  const visibleBreakdown = useMemo<BreakdownSeries[]>(() => {
    const toPoints = (xs: SeriesPoint[]) =>
      xs.map((p) => ({ timestamp: p.timestamp, value: p.volumeUSD }));
    return [
      {
        name: "v3",
        color: V3_COLOR,
        series: toPoints(visibleV3Points),
      },
      {
        name: "v2",
        color: V2_COLOR,
        series: toPoints(visibleV2Points),
      },
    ];
  }, [visibleV3Points, visibleV2Points]);

  // Per-version range totals — rolling-window bucketing means each side's
  // sum equals that version's volume for the visible range.
  const v3RangeTotal = useMemo(
    () => visibleV3Points.reduce((sum, p) => sum + p.volumeUSD, 0),
    [visibleV3Points],
  );
  const v2RangeTotal = useMemo(
    () => visibleV2Points.reduce((sum, p) => sum + p.volumeUSD, 0),
    [visibleV2Points],
  );

  // Stacked-total series for the chart card. Required because the card's
  // y-axis ceiling is derived from `max([...series.value, ...breakdownYs])`,
  // and Plotly's `stackgroup: "total"` renders cumulative heights — so the
  // ceiling must reflect the per-day v3+v2 sum, not just whichever
  // individual trace happens to be largest. Without this, on any day where
  // v2 ≥ ~35% of v3 the stacked top exceeds y-max and Plotly clips the
  // upper bars. Day buckets are aligned (both helpers floor to UTC-day),
  // so summing by timestamp is exact.
  const visibleSeriesForCard = useMemo<TimeSeriesPoint[]>(() => {
    const byTs = new Map<number, number>();
    for (const p of visibleV3Points)
      byTs.set(p.timestamp, (byTs.get(p.timestamp) ?? 0) + p.volumeUSD);
    for (const p of visibleV2Points)
      byTs.set(p.timestamp, (byTs.get(p.timestamp) ?? 0) + p.volumeUSD);
    return Array.from(byTs)
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({ timestamp, value }));
  }, [visibleV3Points, visibleV2Points]);

  const headline = computeHeadline(
    isLoading,
    hasError,
    hasSnapshotError,
    hasBrokerSnapshotError,
    visibleVolumePartial,
    visibleV3Points,
    visibleV2Points,
    v3RangeTotal,
    v2RangeTotal,
  );

  const change = weekOverWeekChangePct(fullV3Series);

  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : visibleVolumePartial === null
        ? "Historical volume unavailable — token decimals unverified"
        : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Volume chart time range"
      series={visibleSeriesForCard}
      breakdown={visibleBreakdown}
      breakdownMode="stacked"
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change}
      changeLabel="v3 week-over-week"
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError || visibleVolumePartial === true}
      emptyMessage={emptyMessage}
    />
  );
}
