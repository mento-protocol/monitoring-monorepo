"use client";

import { useMemo, useState } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { parseWei } from "@/lib/format";
import {
  SECONDS_PER_DAY,
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { formatTokenAmount } from "../../_lib/format";
import type { CdpInstanceDailySnapshot } from "../../_lib/types";

// Point-to-point WoW change: compare the current value to a snapshot inside
// [now - 14d, now - 7d]. Sparse histories (low-activity markets, backfill
// gaps) otherwise pick an arbitrarily-old point and silently attribute e.g.
// a 30-day delta to the "week-over-week" caption. Matches the logic in
// PoolTvlOverTimeChart — no shared helper exists yet.
function spDepositsWoWChangePct(series: TimeSeriesPoint[]): number | null {
  if (series.length < 2) return null;
  const now = series[series.length - 1];
  const upperCutoff = now.timestamp - 7 * SECONDS_PER_DAY;
  const lowerCutoff = now.timestamp - 14 * SECONDS_PER_DAY;
  let ago: TimeSeriesPoint | null = null;
  for (let i = series.length - 2; i >= 0; i--) {
    const ts = series[i].timestamp;
    if (ts > upperCutoff) continue;
    if (ts < lowerCutoff) break;
    ago = series[i];
    break;
  }
  if (!ago || ago.value <= 0) return null;
  return ((now.value - ago.value) / ago.value) * 100;
}

interface CdpStabilityPoolTvlChartProps {
  snapshots: CdpInstanceDailySnapshot[];
  /** Current spDeposits from LiquityInstance; appended as the latest point. */
  currentSpDeposits: string | null | undefined;
  /** Debt-token symbol (GBPm, EURm, …) used for the chart unit. */
  symbol: string;
  isLoading: boolean;
  hasError: boolean;
}

export function CdpStabilityPoolTvlChart({
  snapshots,
  currentSpDeposits,
  symbol,
  isLoading,
  hasError,
}: CdpStabilityPoolTvlChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (snapshots.length === 0 && currentSpDeposits == null) return [];
    // Query returns desc (newest-first) to preserve recent rows when the
    // 1000-row cap kicks in. Reverse here so Plotly receives chronological.
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    const sorted = [...snapshots].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    const points: TimeSeriesPoint[] = sorted.map((snap) => ({
      timestamp: Number(snap.timestamp),
      value: parseWei(snap.spDeposits),
    }));
    if (currentSpDeposits != null) {
      const live = parseWei(currentSpDeposits);
      const nowSec = Math.floor(Date.now() / 1000);
      // Append the live current value as the trailing point so the chart
      // reflects intra-day changes that haven't yet been rolled into a
      // daily snapshot.
      points.push({ timestamp: nowSec, value: live });
    }
    return points;
  }, [snapshots, currentSpDeposits]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const change7d = useMemo(
    () => spDepositsWoWChangePct(fullSeries),
    [fullSeries],
  );

  const headline = isLoading
    ? "…"
    : currentSpDeposits == null
      ? "—"
      : formatTokenAmount(currentSpDeposits, symbol);

  return (
    <TimeSeriesChartCard
      title="Stability Pool TVL"
      rangeAriaLabel="Stability pool TVL chart time range"
      series={visibleSeries}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change7d}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={false}
      emptyMessage={
        hasError
          ? "Unable to load stability pool history"
          : "Not enough stability pool history yet"
      }
    />
  );
}
