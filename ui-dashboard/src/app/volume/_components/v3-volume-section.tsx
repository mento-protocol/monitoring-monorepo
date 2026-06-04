"use client";

import type {
  VolumeRangeKey,
  TraderDailyRow,
  TraderWindowRow,
} from "@/lib/volume";
import type { AggregatorWindowRow } from "@/lib/volume-aggregators";
import type { VolumeExclusionState } from "@/lib/volume-exclusions";
import { VolumeTable } from "./volume-table";
import {
  AggregatorBreakdownSection,
  type AggregatorChartProps,
} from "./aggregator-breakdown-section";
import type { PoolMeta } from "../_lib/types";
import { V3FlowInsights } from "./v3-flow-insights";
import { TableSectionTitle } from "./table-section-title";

type V3TableState = {
  isLoading: boolean;
  hasError: boolean;
  isCapHit: boolean;
  hasExploratoryExclusions: boolean;
};

type V3AggregatorState = {
  isLoading: boolean;
  hasError: boolean;
  isCapHit: boolean;
};

export function V3VolumeSection({
  rangeLabel,
  range,
  cutoff,
  filteredTraderRows,
  traders,
  pools,
  protocolActorFilter,
  exclusions,
  tableState,
  aggregators,
  aggregatorState,
  chart,
}: {
  rangeLabel: string;
  range: VolumeRangeKey;
  cutoff: number;
  filteredTraderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  pools: PoolMeta;
  protocolActorFilter: ReadonlyArray<boolean>;
  exclusions: VolumeExclusionState;
  tableState: V3TableState;
  aggregators: readonly AggregatorWindowRow[];
  aggregatorState: V3AggregatorState;
  chart?: AggregatorChartProps | undefined;
}) {
  return (
    <>
      <V3FlowInsights
        range={range}
        rangeLabel={rangeLabel}
        cutoff={cutoff}
        traderRows={filteredTraderRows}
        traders={traders}
        pools={pools}
        protocolActorFilter={protocolActorFilter}
        exclusions={exclusions}
        tableState={{
          isLoading: tableState.isLoading,
          hasError: tableState.hasError,
          isCapHit: tableState.isCapHit,
        }}
      />
      <section>
        <TableSectionTitle
          label="About top traders table"
          info="Ranks signer wallets by v3 Mento pool and VirtualPool USD volume in this window. Protocol actors are excluded unless included."
        >
          Top traders ({rangeLabel})
        </TableSectionTitle>
        <VolumeTable
          cutoff={cutoff}
          traders={traders}
          pools={pools}
          isLoading={tableState.isLoading}
          hasError={tableState.hasError}
          hasExploratoryExclusions={tableState.hasExploratoryExclusions}
        />
      </section>
      <AggregatorBreakdownSection
        venueLabel="v3"
        rangeLabel={rangeLabel}
        aggregators={aggregators}
        isLoading={aggregatorState.isLoading}
        hasError={aggregatorState.hasError}
        isCapHit={aggregatorState.isCapHit}
        chart={chart}
      />
    </>
  );
}
