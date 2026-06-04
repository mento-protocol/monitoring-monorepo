import { useMemo } from "react";
import { clusterNames } from "@mento-protocol/monitoring-config/aggregators";
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
import {
  filterAggregatorRowsByVolumeExclusions,
  filterBrokerTraderRowsByVolumeExclusions,
  filterTraderRowsByVolumeExclusions,
  hasVolumeExclusions,
} from "@/lib/volume-exclusions";
import type { VolumeUrlState } from "../page-client";

const CLUSTER_SOURCE_OPTIONS = clusterNames();

export function useVolumeAggregates({
  exclusions,
  venue,
  includeProtocolActors,
  traderRows,
  v2TraderRows,
  v3AggregatorRows,
  v2AggregatorRows,
}: {
  exclusions: VolumeUrlState["exclusions"];
  venue: VolumeUrlState["venue"];
  includeProtocolActors: boolean;
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
  v2AggregatorRows: readonly BrokerAggregatorDailyRow[];
}) {
  const exclusionModel = useVolumeExclusionModel({
    exclusions,
    venue,
    includeProtocolActors,
    traderRows,
    v2TraderRows,
    v3AggregatorRows,
    v2AggregatorRows,
  });
  const {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
  } = exclusionModel;

  const aggregated = useMemo(
    () => aggregateTradersByWindow(filteredTraderRows),
    [filteredTraderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(filteredTraderRows),
    [filteredTraderRows],
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
    () => aggregateDailyVolume(filteredV2TraderRows),
    [filteredV2TraderRows],
  );
  return {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
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

function useVolumeExclusionModel({
  exclusions,
  venue,
  includeProtocolActors,
  traderRows,
  v2TraderRows,
  v3AggregatorRows,
  v2AggregatorRows,
}: {
  exclusions: VolumeUrlState["exclusions"];
  venue: VolumeUrlState["venue"];
  includeProtocolActors: boolean;
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
  v2AggregatorRows: readonly BrokerAggregatorDailyRow[];
}) {
  const hasExploratoryExclusions = hasVolumeExclusions(exclusions);
  const filteredTraderRows = useMemo(
    () => filterTraderRowsByVolumeExclusions(traderRows, exclusions),
    [traderRows, exclusions],
  );
  const filteredV2TraderRows = useMemo(
    () => filterBrokerTraderRowsByVolumeExclusions(v2TraderRows, exclusions),
    [v2TraderRows, exclusions],
  );
  const selectedV3AggregatorRows = useMemo(
    () =>
      selectAggregatorRowsForActorFilter(
        v3AggregatorRows,
        includeProtocolActors,
      ),
    [v3AggregatorRows, includeProtocolActors],
  );
  const filteredV3AggregatorRows = useMemo(
    () =>
      filterAggregatorRowsByVolumeExclusions(
        selectedV3AggregatorRows,
        exclusions,
      ),
    [selectedV3AggregatorRows, exclusions],
  );
  const selectedV2AggregatorRows = useMemo(
    () =>
      includeProtocolActors
        ? v2AggregatorRows
        : v2AggregatorRows.filter((r) => r.aggregator !== "protocol"),
    [v2AggregatorRows, includeProtocolActors],
  );
  const filteredV2AggregatorRows = useMemo(
    () =>
      filterAggregatorRowsByVolumeExclusions(
        selectedV2AggregatorRows,
        exclusions,
      ),
    [selectedV2AggregatorRows, exclusions],
  );
  const sourceOptions = useMemo(
    () =>
      venue === "v3"
        ? buildSourceOptions({
            traderRows,
            v3AggregatorRows,
          })
        : [],
    [venue, traderRows, v3AggregatorRows],
  );
  return {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
  };
}

export function volumeExclusionsForVenue(
  venue: VolumeUrlState["venue"],
  exclusions: VolumeUrlState["exclusions"],
): VolumeUrlState["exclusions"] {
  if (venue === "v3" || exclusions.sources.length === 0) return exclusions;
  return { addresses: exclusions.addresses, sources: [] };
}

function buildSourceOptions({
  traderRows,
  v3AggregatorRows,
}: {
  traderRows: readonly TraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of CLUSTER_SOURCE_OPTIONS) appendSource(out, seen, source);
  for (const row of traderRows) {
    for (const source of row.aggregatorKeys ?? []) {
      appendSource(out, seen, source);
    }
  }
  for (const row of v3AggregatorRows) appendSource(out, seen, row.aggregator);
  return out;
}

function appendSource(out: string[], seen: Set<string>, source: string): void {
  const normalized = source.toLowerCase();
  if (seen.has(normalized)) return;
  seen.add(normalized);
  out.push(normalized);
}
