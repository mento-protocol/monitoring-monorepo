"use client";

import { useMemo, useState } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import { filterSeriesByRange, type RangeKey } from "@/lib/time-series";
import type { OracleRateMap } from "@/lib/tokens";
import type { BridgeDailySnapshot } from "@/lib/types";
import {
  buildVolumeUsdSeries,
  weekOverWeekChange,
} from "@/lib/bridge-flows/snapshots";

interface BridgeVolumeChartProps {
  snapshots: BridgeDailySnapshot[];
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
  /**
   * True when the snapshot query hit Hasura's 1000-row cap. The card
   * surfaces a "partial data" note and the chart still renders whatever
   * rows came back.
   */
  isCapped?: boolean;
}

export function BridgeVolumeChart({
  snapshots,
  rates,
  isLoading,
  hasError,
  isCapped = false,
}: BridgeVolumeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  // Build the full series once; the range tab only affects what's visible.
  // Keep both so headline math and WoW delta always see the full dataset
  // (important for 7d view where WoW needs last-14d rows).
  const fullSeries = useMemo(
    () => buildVolumeUsdSeries(snapshots, rates),
    [snapshots, rates],
  );
  const rangeSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const rangeTotal = rangeSeries.reduce((sum, p) => sum + p.value, 0);
  const wow = weekOverWeekChange(fullSeries);

  return (
    <TimeSeriesChartCard
      title="Bridged Volume (USD)"
      rangeAriaLabel="Volume time range"
      series={rangeSeries}
      range={range}
      onRangeChange={setRange}
      headline={rangeTotal > 0 ? formatUSD(rangeTotal) : "$0"}
      change={wow}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={isCapped}
      emptyMessage="No bridge volume in the selected window."
    />
  );
}
