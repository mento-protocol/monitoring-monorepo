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
  custodySnapshotsAlignedToSupplyRows,
  custodyTokenKey,
  groupCustodySnapshotsByToken,
  groupSnapshotsByTokenSource,
  sumTotalUsdSeries,
  unionSnapshotsWithLatest,
} from "../_lib/aggregate";
import type {
  RangeKey,
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
} from "../_lib/types";

type Props = {
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  // Current row per `(tokenAddress, source)` from `useStablesLatestPerToken` —
  // used as a baseline floor for tokens whose history is paginated out of
  // `snapshots` once the 1000-row cap hits. Without it, a token with no
  // in-range snapshot disappears from the stacked total even though
  // `latestPerToken` knows its current supply.
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  custodySnapshots: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  latestCustodyPerToken: ReadonlyArray<StableTokenCustodyDailySnapshot>;
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
  custodySnapshots,
  latestCustodyPerToken,
  rates,
  range,
  onRangeChange,
  isLoading,
  hasError,
  capped,
}: Props): React.JSX.Element {
  // Group snapshots by `{chainId}|{tokenAddress}|{source}` so Celo and Monad
  // supplies stay distinct before the stacked total sums them.
  const { breakdown, totalSeries } = useMemo(() => {
    if (snapshots.length === 0 && latestPerToken.length === 0) {
      return { breakdown: [] as BreakdownSeries[], totalSeries: [] };
    }
    const merged = unionSnapshotsWithLatest(snapshots, latestPerToken);
    const mergedCustody = custodySnapshotsAlignedToSupplyRows(
      merged,
      custodySnapshots,
      latestCustodyPerToken,
    );
    // Shared discriminator with `_lib/aggregate.ts` so KPI strip and hero
    // chart group Celo cUSD-USDm vs V3 hub USDm identically.
    const grouped = groupSnapshotsByTokenSource(merged);
    const custodyByToken = groupCustodySnapshotsByToken(mergedCustody);
    // Shared x-axis start across all per-token series. Critical for
    // `range === "all"` — `rangeStartSeconds("all")` returns 0 (epoch),
    // and a naive per-token iteration would generate ~20K days per
    // token and freeze the browser. `computeChartStartSeconds` clamps
    // `"all"` to the earliest observed snapshot.
    const effectiveStartTs = computeChartStartSeconds(grouped, range);

    const breakdownEntries: BreakdownSeries[] = [];
    const allSeries: Array<Array<{ timestamp: number; valueUsd: number }>> = [];
    for (const [key, rows] of grouped) {
      const sample = rows[0]!;
      const custodyRows =
        custodyByToken.get(
          custodyTokenKey(sample.chainId, sample.tokenAddress),
        ) ?? [];
      const series = buildTokenUsdTimeSeries(
        rows,
        rates,
        effectiveStartTs,
        undefined,
        custodyRows,
      );
      if (series.length === 0) continue;
      breakdownEntries.push({
        id: key,
        name: `${displayLabel(sample.tokenSymbol, sample.source)} on ${chainLabel(sample.chainId)}`,
        // reserve USDm and V3 hub USDm share `tokenSymbol` but live at
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
  }, [
    snapshots,
    latestPerToken,
    custodySnapshots,
    latestCustodyPerToken,
    rates,
    range,
  ]);

  const headline =
    totalSeries.length > 0
      ? formatUSD(totalSeries[totalSeries.length - 1]!.value)
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
        emptyMessage="No stablecoin supply data yet."
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

function chainLabel(chainId: number): string {
  if (chainId === 143) return "Monad";
  if (chainId === 42220) return "Celo";
  return `Chain ${chainId}`;
}
