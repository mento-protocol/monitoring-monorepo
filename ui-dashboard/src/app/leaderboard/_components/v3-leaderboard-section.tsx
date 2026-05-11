"use client";

import type { TraderWindowRow } from "@/lib/leaderboard";
import type { AggregatorWindowRow } from "@/lib/leaderboard-aggregators";
import { LeaderboardTable } from "./leaderboard-table";
import {
  AggregatorBreakdownSection,
  type AggregatorChartProps,
} from "./aggregator-breakdown-section";

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
  chart?: AggregatorChartProps;
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
        chart={chart}
      />
    </>
  );
}
