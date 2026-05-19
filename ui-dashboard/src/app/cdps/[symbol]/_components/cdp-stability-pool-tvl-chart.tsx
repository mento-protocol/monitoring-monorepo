"use client";

import { useMemo, useState } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { parseWei } from "@/lib/format";
import {
  filterSeriesByRange,
  stockWoWChangePct,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { formatTokenAmount } from "../../_lib/format";
import type { CdpInstanceDailySnapshot } from "../../_lib/types";

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

  // Query returns desc (newest-first) to preserve recent rows when the
  // 1000-row cap kicks in. Reverse here so Plotly receives chronological.
  const historicalSeries = useMemo<TimeSeriesPoint[]>(() => {
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    const sorted = [...snapshots].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    return sorted.map((snap) => ({
      timestamp: Number(snap.timestamp),
      value: parseWei(snap.spDeposits),
    }));
  }, [snapshots]);

  // Append the live spDeposits as the trailing point so the chart reflects
  // intra-day changes that haven't yet been rolled into a daily snapshot.
  // Separate from historicalSeries so the 30s SWR poll on currentSpDeposits
  // doesn't re-sort the full snapshot history.
  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (currentSpDeposits == null) return historicalSeries;
    const nowSec = Math.floor(Date.now() / 1000);
    return [
      ...historicalSeries,
      { timestamp: nowSec, value: parseWei(currentSpDeposits) },
    ];
  }, [historicalSeries, currentSpDeposits]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const change7d = useMemo(() => stockWoWChangePct(fullSeries), [fullSeries]);

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
