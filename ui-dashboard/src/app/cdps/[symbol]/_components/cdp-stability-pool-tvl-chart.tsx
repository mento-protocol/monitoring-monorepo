"use client";

import { useMemo, useState } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { parseWei } from "@/lib/format";
import { escapePlotText } from "@/lib/plot";
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
  /** Strategy reserve target left in the SP after CDP rebalances. */
  minBoldAfterRebalance?: string | null | undefined;
  /** Debt-token symbol (GBPm, EURm, …) used for the chart unit. */
  symbol: string;
  isLoading: boolean;
  hasError: boolean;
}

export function buildStabilityPoolTvlSeries(
  snapshots: CdpInstanceDailySnapshot[],
  currentSpDeposits: string | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): TimeSeriesPoint[] {
  // Query returns desc (newest-first) to preserve recent rows when the
  // 1000-row cap kicks in. Reverse here so Plotly receives chronological.
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
  const sorted = [...snapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const series = sorted.map((snap) => ({
    timestamp: Number(snap.timestamp),
    value: parseWei(snap.spDeposits),
  }));

  // Append the live spDeposits as the trailing point so the chart reflects
  // intra-day changes that haven't yet been rolled into a daily snapshot.
  if (currentSpDeposits != null) {
    series.push({ timestamp: nowSec, value: parseWei(currentSpDeposits) });
  }

  const firstPositive = series.findIndex((point) => point.value > 0);
  if (firstPositive >= 0) return series.slice(firstPositive);
  return series.length > 0 ? [series[series.length - 1]!] : [];
}

type RebalanceReserveReference = {
  shapes: Plotly.Layout["shapes"];
  annotations: Plotly.Layout["annotations"];
  yAxisReferenceValues: readonly number[];
};

export function buildRebalanceReserveReference(
  minBoldAfterRebalance: string | null | undefined,
  symbol: string,
): RebalanceReserveReference | null {
  if (minBoldAfterRebalance == null) return null;
  const value = parseWei(minBoldAfterRebalance);
  if (value <= 0) return null;

  return {
    shapes: [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: value,
        y1: value,
        line: { color: "#f59e0b", width: 1, dash: "dash" },
      },
    ],
    annotations: [
      {
        xref: "paper",
        x: 1,
        xanchor: "right",
        yref: "y",
        y: value,
        yanchor: "bottom",
        text: escapePlotText(
          `Rebalance reserve ${formatTokenAmount(minBoldAfterRebalance, symbol)}`,
        ),
        showarrow: false,
        font: { color: "#fbbf24", size: 11 },
        bgcolor: "rgba(15,23,42,0.82)",
        bordercolor: "rgba(245,158,11,0.45)",
        borderwidth: 1,
        borderpad: 3,
      },
    ],
    yAxisReferenceValues: [value],
  };
}

export function CdpStabilityPoolTvlChart({
  snapshots,
  currentSpDeposits,
  minBoldAfterRebalance,
  symbol,
  isLoading,
  hasError,
}: CdpStabilityPoolTvlChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    return buildStabilityPoolTvlSeries(snapshots, currentSpDeposits);
  }, [snapshots, currentSpDeposits]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const change7d = useMemo(() => stockWoWChangePct(fullSeries), [fullSeries]);

  const reserveReference = useMemo(
    () => buildRebalanceReserveReference(minBoldAfterRebalance, symbol),
    [minBoldAfterRebalance, symbol],
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
      {...(reserveReference
        ? {
            shapes: reserveReference.shapes,
            annotations: reserveReference.annotations,
            yAxisReferenceValues: reserveReference.yAxisReferenceValues,
          }
        : {})}
      emptyMessage={
        hasError
          ? "Unable to load stability pool history"
          : "Not enough stability pool history yet"
      }
    />
  );
}
