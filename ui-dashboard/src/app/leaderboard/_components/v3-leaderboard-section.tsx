"use client";

import type {
  LeaderboardRangeKey,
  TraderDailyRow,
  TraderWindowRow,
} from "@/lib/leaderboard";
import type { AggregatorWindowRow } from "@/lib/leaderboard-aggregators";
import { LeaderboardTable } from "./leaderboard-table";
import {
  AggregatorBreakdownSection,
  type AggregatorChartProps,
} from "./aggregator-breakdown-section";
import type { PoolMeta } from "../_lib/types";
import { V3FlowInsights } from "./v3-flow-insights";
import { TableSectionTitle } from "./table-section-title";

export function V3LeaderboardSection({
  rangeLabel,
  range,
  cutoff,
  traderRows,
  traders,
  pools,
  isSystemAddressIn,
  tableIsLoading,
  tableHasError,
  isTraderCapHit,
  aggregators,
  aggIsLoading,
  aggHasError,
  isAggregatorCapHit,
  chart,
}: {
  rangeLabel: string;
  range: LeaderboardRangeKey;
  cutoff: number;
  traderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  pools: PoolMeta;
  isSystemAddressIn: ReadonlyArray<boolean>;
  tableIsLoading: boolean;
  tableHasError: boolean;
  isTraderCapHit: boolean;
  aggregators: readonly AggregatorWindowRow[];
  aggIsLoading: boolean;
  aggHasError: boolean;
  isAggregatorCapHit: boolean;
  chart?: AggregatorChartProps | undefined;
}) {
  return (
    <>
      <V3FlowInsights
        range={range}
        rangeLabel={rangeLabel}
        cutoff={cutoff}
        traderRows={traderRows}
        traders={traders}
        pools={pools}
        isSystemAddressIn={isSystemAddressIn}
        isTraderCapHit={isTraderCapHit}
        tableIsLoading={tableIsLoading}
        tableHasError={tableHasError}
      />
      <section>
        <TableSectionTitle
          label="About top traders table"
          info="Ranks signer wallets by v3 Mento pool and VirtualPool USD volume in this window. System addresses are hidden unless enabled."
        >
          Top traders ({rangeLabel})
        </TableSectionTitle>
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
