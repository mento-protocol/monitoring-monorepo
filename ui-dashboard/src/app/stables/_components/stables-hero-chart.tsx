"use client";

import { useMemo } from "react";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import type { BreakdownSeries } from "@/components/time-series-chart-card-overlays";
import { formatUSD } from "@/lib/format";
import { displayLabel } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import { tokenColorForSource } from "@/lib/token-colors";
import { stockWoWChangePct } from "@/lib/time-series";
import {
  buildTokenUsdTimeSeries,
  computeChartStartSeconds,
  groupSnapshotsByTokenSource,
  sumTotalUsdSeries,
} from "../_lib/aggregate";
import type { RangeKey, StableSupplyDailySnapshot } from "../_lib/types";

type Props = {
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  // Latest snapshot per `(tokenAddress, source)` from
  // `useStablesLatestPerToken` — used as a baseline floor for tokens
  // whose history is paginated out of `snapshots` once the 1000-row
  // cap hits. Without it, a token with no in-range snapshot disappears
  // from the stacked total even though `latestPerToken` knows its
  // current supply.
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  rates: OracleRateMap;
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  isLoading: boolean;
  hasError: boolean;
  capped: boolean;
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
  latestPerToken,
  rates,
  range,
  onRangeChange,
  isLoading,
  hasError,
  capped,
}: Props): React.JSX.Element {
  // Group snapshots by `{tokenAddress}|{source}` so V2 cUSD-USDm and V3 hub
  // USDm get distinct stack slices (same symbol "USDm", different addresses).
  const { breakdown, totalSeries } = useMemo(() => {
    if (snapshots.length === 0 && latestPerToken.length === 0) {
      return { breakdown: [] as BreakdownSeries[], totalSeries: [] };
    }
    // Union the daily-snapshot stream with `latestPerToken` so tokens
    // whose only known snapshot is older than the retained 1000-row page
    // still contribute their last-known supply to the stacked total.
    // De-dupe on (chainId, tokenAddress, source, timestamp) by row id —
    // `latestPerToken` rows share the same id shape as `snapshots`, so
    // a Map by id collapses duplicates correctly.
    const byId = new Map<string, StableSupplyDailySnapshot>();
    for (const r of snapshots) byId.set(r.id, r);
    for (const r of latestPerToken) if (!byId.has(r.id)) byId.set(r.id, r);
    const merged = Array.from(byId.values());
    // Shared discriminator with `_lib/aggregate.ts` so KPI strip and hero
    // chart group V2 cUSD-USDm vs V3 hub USDm identically.
    const grouped = groupSnapshotsByTokenSource(merged);
    // Shared x-axis start across all per-token series. Critical for
    // `range === "all"` — `rangeStartSeconds("all")` returns 0 (epoch),
    // and a naive per-token iteration would generate ~20K days per
    // token and freeze the browser. `computeChartStartSeconds` clamps
    // `"all"` to the earliest observed snapshot.
    const effectiveStartTs = computeChartStartSeconds(grouped, range);

    const breakdownEntries: BreakdownSeries[] = [];
    const allSeries: Array<Array<{ timestamp: number; valueUsd: number }>> = [];
    for (const [key, rows] of grouped) {
      const series = buildTokenUsdTimeSeries(rows, rates, effectiveStartTs);
      if (series.length === 0) continue;
      const sample = rows[0];
      breakdownEntries.push({
        id: key,
        name: displayLabel(sample.tokenSymbol, sample.source),
        // V2 USDm and V3 hub USDm share `tokenSymbol` but live at
        // distinct addresses; source-aware coloring keeps the stacked
        // chart's two USDm slices visually distinct (otherwise they
        // merge into a single emerald block).
        color: tokenColorForSource(sample.tokenSymbol, sample.source),
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
    <div className="space-y-2">
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
      {capped ? (
        <p className="text-xs text-amber-400" role="status">
          Showing the most recent 1,000 snapshot rows — older history may be
          truncated. Use the 1W or 1M range for a complete view.
        </p>
      ) : null}
    </div>
  );
}
