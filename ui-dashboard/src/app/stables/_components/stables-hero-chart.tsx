"use client";

import { useMemo } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import type { BreakdownSeries } from "@/components/time-series-chart-card-overlays";
import { formatUSD } from "@/lib/format";
import { displayLabel } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import { tokenColor } from "@/lib/token-colors";
import { stockWoWChangePct } from "@/lib/time-series";
import { buildTokenUsdTimeSeries, sumTotalUsdSeries } from "../_lib/aggregate";
import type { RangeKey, StableSupplyDailySnapshot } from "../_lib/types";

type Props = {
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  rates: OracleRateMap;
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  isLoading: boolean;
  hasError: boolean;
};

/**
 * Total Mento stablecoin supply over time, USD-normalized, stacked by token.
 * Cross-currency supplies only stack meaningfully in a common unit — tokens
 * without an oracle rate (e.g. a new stable that hasn't been listed in a
 * USDm-paired pool yet) are dropped from the stack and surfaced in the
 * sparkline grid below instead.
 */
export function StablesHeroChart({
  snapshots,
  rates,
  range,
  onRangeChange,
  isLoading,
  hasError,
}: Props): React.JSX.Element {
  // Group snapshots by `{tokenAddress}|{source}` so V2 cUSD-USDm and V3 hub
  // USDm get distinct stack slices (same symbol "USDm", different addresses).
  const { breakdown, totalSeries } = useMemo(() => {
    if (snapshots.length === 0) {
      return { breakdown: [] as BreakdownSeries[], totalSeries: [] };
    }
    const grouped = new Map<string, StableSupplyDailySnapshot[]>();
    for (const row of snapshots) {
      const key = `${row.tokenAddress}|${row.source}`;
      let arr = grouped.get(key);
      if (!arr) {
        arr = [];
        grouped.set(key, arr);
      }
      arr.push(row);
    }

    const breakdownEntries: BreakdownSeries[] = [];
    const allSeries: Array<Array<{ timestamp: number; valueUsd: number }>> = [];
    for (const [key, rows] of grouped) {
      const series = buildTokenUsdTimeSeries(rows, rates, range);
      if (series.length === 0) continue;
      const sample = rows[0];
      breakdownEntries.push({
        id: key,
        name: displayLabel(sample.tokenSymbol, sample.source),
        color: tokenColor(sample.tokenSymbol),
        series: series.map((p) => ({
          timestamp: p.timestamp,
          value: p.valueUsd,
        })),
      });
      allSeries.push(series);
    }

    const totalUsd = sumTotalUsdSeries(allSeries).map((p) => ({
      timestamp: p.timestamp,
      value: p.valueUsd,
    }));
    return { breakdown: breakdownEntries, totalSeries: totalUsd };
  }, [snapshots, rates, range]);

  const headline =
    totalSeries.length > 0
      ? formatUSD(totalSeries[totalSeries.length - 1].value)
      : "—";
  const change = stockWoWChangePct(totalSeries);

  return (
    <TimeSeriesChartCard
      title="Mento stablecoin supply"
      rangeAriaLabel="Mento stablecoin supply range"
      series={totalSeries}
      breakdown={breakdown}
      breakdownMode="stacked"
      range={range}
      onRangeChange={onRangeChange}
      headline={headline}
      change={change}
      changeLabel="vs. 7d ago"
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={false}
      emptyMessage="No stablecoin supply data yet for this chain."
    />
  );
}
