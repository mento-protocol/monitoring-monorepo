import { useMemo } from "react";
import {
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregateTradersByWindow,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type TraderDailyRow,
} from "@/lib/volume";
import {
  aggregateAggregatorsByWindow,
  selectAggregatorRowsForActorFilter,
  type AggregatorDailyRow,
} from "@/lib/volume-aggregators";

export function useVolumeAggregates({
  includeProtocolActors,
  traderRows,
  v2TraderRows,
  v3AggregatorRows,
  v2AggregatorRows,
}: {
  includeProtocolActors: boolean;
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
  v2AggregatorRows: readonly BrokerAggregatorDailyRow[];
}) {
  const filteredTraderRows = traderRows;
  const filteredV2TraderRows = v2TraderRows;
  const filteredV3AggregatorRows = useMemo(
    () =>
      selectAggregatorRowsForActorFilter(
        v3AggregatorRows,
        includeProtocolActors,
      ),
    [v3AggregatorRows, includeProtocolActors],
  );
  const filteredV2AggregatorRows = useMemo(
    () =>
      selectAggregatorRowsForActorFilter(
        v2AggregatorRows,
        includeProtocolActors,
      ),
    [v2AggregatorRows, includeProtocolActors],
  );

  const aggregated = useMemo(
    () => aggregateTradersByWindow(filteredTraderRows),
    [filteredTraderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(traderRows),
    [traderRows],
  );
  const unfilteredAggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
    [traderRows],
  );
  const v2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(filteredV2TraderRows),
    [filteredV2TraderRows],
  );
  const unfilteredV2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(v2TraderRows),
    [v2TraderRows],
  );
  const v3AggregatorAggregated = useMemo(
    () => aggregateAggregatorsByWindow(filteredV3AggregatorRows),
    [filteredV3AggregatorRows],
  );
  const v2AggregatorAggregated = useMemo(
    () => aggregateAggregatorsByWindow(filteredV2AggregatorRows),
    [filteredV2AggregatorRows],
  );
  const v2DailyVolume = useMemo(
    () => aggregateDailyVolume(v2TraderRows),
    [v2TraderRows],
  );
  return {
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    aggregated,
    dailyVolume,
    unfilteredAggregated,
    v2Aggregated,
    unfilteredV2Aggregated,
    v3AggregatorAggregated,
    v2AggregatorAggregated,
    v2DailyVolume,
  };
}
