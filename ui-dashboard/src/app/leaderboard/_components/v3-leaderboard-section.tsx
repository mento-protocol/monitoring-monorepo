"use client";

import { formatUSD } from "@/lib/format";
import type { RangeKey } from "@/lib/time-series";
import type { TraderWindowRow } from "@/lib/leaderboard";
import type { AggregatorWindowRow } from "@/lib/leaderboard-aggregators";
import type { BreakdownSeries } from "@/components/time-series-chart-card";
import { LeaderboardTable } from "./leaderboard-table";
import { AggregatorBreakdownSection } from "./aggregator-breakdown-section";

type PoolMeta = ReadonlyMap<
  string,
  { token0: string | null; token1: string | null }
>;

export function V3LeaderboardSection({
  rangeLabel,
  cutoff,
  traders,
  pools,
  tableIsLoading,
  tableHasError,
  aggregators,
  aggIsLoading,
  aggHasError,
  isAggregatorCapHit,
  chart,
}: {
  rangeLabel: string;
  cutoff: number;
  traders: readonly TraderWindowRow[];
  pools: PoolMeta;
  tableIsLoading: boolean;
  tableHasError: boolean;
  aggregators: readonly AggregatorWindowRow[];
  aggIsLoading: boolean;
  aggHasError: boolean;
  isAggregatorCapHit: boolean;
  chart?: {
    series: Array<{ timestamp: number; value: number }>;
    breakdown: BreakdownSeries[];
    range: RangeKey;
    onRangeChange: (range: RangeKey) => void;
    ranges: ReadonlyArray<{ key: RangeKey; label: string }>;
    total: number;
  };
}) {
  return (
    <>
      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-300">
          Top traders ({rangeLabel})
        </h2>
        <LeaderboardTable
          cutoff={cutoff}
          traders={traders}
          pools={pools}
          isLoading={tableIsLoading}
          hasError={tableHasError}
        />
      </section>
      <AggregatorBreakdownSection
        venueLabel="v3"
        rangeLabel={rangeLabel}
        aggregators={aggregators}
        isLoading={aggIsLoading}
        hasError={aggHasError}
        isCapHit={isAggregatorCapHit}
        chart={
          chart
            ? {
                series: chart.series,
                breakdown: chart.breakdown,
                range: chart.range,
                onRangeChange: chart.onRangeChange,
                ranges: chart.ranges,
                headline: formatUSD(chart.total),
              }
            : undefined
        }
      />
    </>
  );
}
