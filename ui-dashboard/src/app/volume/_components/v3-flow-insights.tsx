"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import {
  aggregateTradersByWindow,
  type VolumeRangeKey,
  type TraderDailyRow,
  type TraderPoolDailyRow,
  type TraderWindowRow,
} from "@/lib/volume";
import {
  buildCorridorRows,
  buildTraderCohortSummary,
  filterSwapOutliers,
  previousVolumeWindowBounds,
  traderDayKey,
  type SwapOutlierRow,
} from "@/lib/volume-insights";
import {
  SWAP_EVENT_OUTLIERS,
  TRADER_DAILY_WINDOW_TOP,
  TRADER_POOL_DAILY_TOP,
} from "@/lib/queries/volume";
import {
  SwapEventOutliersSchema,
  TraderDailyWindowTopSchema,
  TraderPoolDailyTopSchema,
} from "@/lib/queries/volume-schemas";
import type { PoolMeta } from "../_lib/types";
import {
  CohortPanel,
  CorridorPanel,
  OutlierPanel,
} from "./v3-flow-insight-panels";

const INSIGHT_ROW_LIMIT = 10;
const SWAP_OUTLIER_FETCH_LIMIT = ENVIO_MAX_ROWS;

type FlowTableState = {
  isLoading: boolean;
  hasError: boolean;
  isCapHit: boolean;
};

export function V3FlowInsights({
  range,
  rangeLabel,
  cutoff,
  traderRows,
  traders,
  pools,
  chainIdIn,
  protocolActorFilter,
  tableState,
}: {
  range: VolumeRangeKey;
  rangeLabel: string;
  cutoff: number;
  traderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  pools: PoolMeta;
  chainIdIn: readonly number[];
  protocolActorFilter: ReadonlyArray<boolean>;
  tableState: FlowTableState;
}) {
  const model = useV3FlowInsightModel({
    range,
    cutoff,
    traderRows,
    traders,
    chainIdIn,
    protocolActorFilter,
    isTraderCapHit: tableState.isCapHit,
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          Flow insights ({rangeLabel})
        </h2>
        {model.insightPartial && (
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-300">
            Approximate top-query view
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <CohortPanel
          range={range}
          summary={model.cohortSummary}
          isLoading={tableState.isLoading || model.previousTradersIsLoading}
          hasError={tableState.hasError || model.previousTradersHasError}
          isPartial={model.isCohortCapHit}
        />
        <CorridorPanel
          rows={model.corridorRows}
          pools={pools}
          isLoading={tableState.isLoading || model.traderPoolIsLoading}
          hasError={tableState.hasError || model.traderPoolHasError}
          isPartial={model.isCorridorCapHit}
        />
        <OutlierPanel
          rows={model.swapOutliers}
          pools={pools}
          isLoading={tableState.isLoading || model.swapOutliersIsLoading}
          hasError={tableState.hasError || model.swapOutliersHasError}
          isPartial={model.isOutlierPartial}
        />
      </div>
    </section>
  );
}

function useV3FlowInsightModel({
  range,
  cutoff,
  traderRows,
  traders,
  chainIdIn,
  protocolActorFilter,
  isTraderCapHit,
}: {
  range: VolumeRangeKey;
  cutoff: number;
  traderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  chainIdIn: readonly number[];
  protocolActorFilter: ReadonlyArray<boolean>;
  isTraderCapHit: boolean;
}) {
  const previousBounds = useMemo(
    () => previousVolumeWindowBounds(range, cutoff),
    [range, cutoff],
  );
  const { previousTradersResult, traderPoolResult, swapOutliersResult } =
    useV3FlowInsightQueries({
      previousBounds,
      cutoff,
      chainIdIn,
      protocolActorFilter,
    });
  const allowedTraderDayKeys = useMemo(
    () => buildAllowedTraderDayKeys(traderRows),
    [traderRows],
  );
  const previousTraders = useMemo(
    () =>
      aggregateTradersByWindow(
        previousTradersResult.data?.TraderDailySnapshot ?? [],
      ),
    [previousTradersResult.data],
  );
  const cohortSummary = useMemo(
    () =>
      previousBounds
        ? buildTraderCohortSummary({
            current: traders,
            previous: previousTraders,
          })
        : null,
    [previousBounds, traders, previousTraders],
  );
  const corridorRows = useMemo(
    () =>
      buildCorridorRows({
        rows: traderPoolResult.data?.TraderPoolDailySnapshot ?? [],
        allowedTraderDayKeys,
        limit: INSIGHT_ROW_LIMIT,
      }),
    [traderPoolResult.data, allowedTraderDayKeys],
  );
  const swapOutliers = useMemo(
    () =>
      filterSwapOutliers({
        rows: swapOutliersResult.data?.SwapEvent ?? [],
        allowedTraderDayKeys,
        limit: INSIGHT_ROW_LIMIT,
      }),
    [swapOutliersResult.data, allowedTraderDayKeys],
  );
  const isSwapOutlierFetchCapHit =
    (swapOutliersResult.data?.SwapEvent.length ?? 0) ===
    SWAP_OUTLIER_FETCH_LIMIT;
  const isCohortCapHit =
    isTraderCapHit ||
    (previousTradersResult.data?.TraderDailySnapshot.length ?? 0) ===
      ENVIO_MAX_ROWS;
  const isCorridorCapHit =
    isTraderCapHit ||
    (traderPoolResult.data?.TraderPoolDailySnapshot.length ?? 0) ===
      ENVIO_MAX_ROWS;
  const isOutlierPartial = isTraderCapHit || isSwapOutlierFetchCapHit;
  return {
    cohortSummary,
    corridorRows,
    swapOutliers,
    previousTradersIsLoading: previousTradersResult.isLoading,
    previousTradersHasError: !!previousTradersResult.error,
    traderPoolIsLoading: traderPoolResult.isLoading,
    traderPoolHasError: !!traderPoolResult.error,
    swapOutliersIsLoading: swapOutliersResult.isLoading,
    swapOutliersHasError: !!swapOutliersResult.error,
    isCohortCapHit,
    isCorridorCapHit,
    isOutlierPartial,
    insightPartial: isCohortCapHit || isCorridorCapHit || isOutlierPartial,
  };
}

function useV3FlowInsightQueries({
  previousBounds,
  cutoff,
  chainIdIn,
  protocolActorFilter,
}: {
  previousBounds:
    | ReturnType<typeof previousVolumeWindowBounds>
    | null
    | undefined;
  cutoff: number;
  chainIdIn: readonly number[];
  protocolActorFilter: ReadonlyArray<boolean>;
}) {
  const previousTradersResult = useGQL<{
    TraderDailySnapshot: TraderDailyRow[];
  }>(
    previousBounds ? TRADER_DAILY_WINDOW_TOP : null,
    previousBounds
      ? {
          afterTimestamp: previousBounds.afterTimestamp,
          beforeTimestamp: previousBounds.beforeTimestamp,
          chainIdIn,
          isProtocolActorIn: protocolActorFilter,
          limit: ENVIO_MAX_ROWS,
        }
      : undefined,
    60_000,
    { timeoutMs: 8_000, schema: TraderDailyWindowTopSchema },
  );
  const traderPoolResult = useGQL<{
    TraderPoolDailySnapshot: TraderPoolDailyRow[];
  }>(
    TRADER_POOL_DAILY_TOP,
    { afterTimestamp: cutoff, chainIdIn, limit: ENVIO_MAX_ROWS },
    60_000,
    { timeoutMs: 8_000, schema: TraderPoolDailyTopSchema },
  );
  const swapOutliersResult = useGQL<{
    SwapEvent: SwapOutlierRow[];
  }>(
    SWAP_EVENT_OUTLIERS,
    { afterTimestamp: cutoff, chainIdIn, limit: SWAP_OUTLIER_FETCH_LIMIT },
    60_000,
    { timeoutMs: 8_000, schema: SwapEventOutliersSchema },
  );
  return { previousTradersResult, traderPoolResult, swapOutliersResult };
}

function buildAllowedTraderDayKeys(
  traderRows: readonly TraderDailyRow[],
): Set<string> {
  const keys = new Set<string>();
  for (const row of traderRows) {
    const key = traderDayKey(row.chainId, row.trader, row.timestamp);
    if (key !== null) keys.add(key);
  }
  return keys;
}
